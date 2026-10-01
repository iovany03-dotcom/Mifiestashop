// Aplica a un pedido (pedidos_online) el estado real de un pago de Mercado
// Pago. Lo usan el webhook (api/mp-webhook.js) y la confirmación al regresar
// de Mercado Pago (api/mp-confirmar.js): así el pedido queda bien aunque
// uno de los dos no llegue.
//
// Estados:
//   approved (y el monto cubre el total del pedido) -> "Pago aceptado"
//   approved pero por MENOS del total             -> "Error en el pago"
//   rejected / cancelled                          -> "Error en el pago"
//   refunded / charged_back                       -> "Reembolsado"
//   pending / in_process / authorized             -> "Pendiente de pago"
//
// Nunca se baja un pedido ya pagado (Mercado Pago puede mandar
// notificaciones viejas o de otro intento fallido), ni se toca un pedido
// que el personal ya movió a Enviado / Entregado / Cancelado.
const { sendMetaEvent } = require('./meta-capi.js');
const { sendTemplate, smtpConfigured } = require('./correo.js');
const { sumarUso } = require('./cupones.js');
const { enviarPushAdmins } = require('./push.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const PAGADO = ['Pago aceptado', 'Pagado'];
const EDITABLES = ['Pendiente', 'Pendiente de pago', 'Error en el pago', ...PAGADO];

function estadoDesdePago(payment, totalPedido) {
  const s = payment.status;
  if (s === 'approved') {
    const pagado = Number(payment.transaction_amount) || 0;
    if (totalPedido > 0 && pagado + 0.01 < totalPedido) return 'Error en el pago';
    return 'Pago aceptado';
  }
  if (s === 'rejected' || s === 'cancelled') return 'Error en el pago';
  if (s === 'refunded' || s === 'charged_back') return 'Reembolsado';
  return 'Pendiente de pago';
}

async function obtenerPago(accessToken, paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payment = await r.json().catch(() => ({}));
  return r.ok ? payment : null;
}

// -> { folio, estado, mpStatus, total } | null si el pago no existe o no
//    corresponde a un pedido.
async function aplicarPago({ accessToken, serviceRoleKey, paymentId, folioEsperado }) {
  const payment = await obtenerPago(accessToken, paymentId);
  if (!payment || !payment.external_reference) return null;
  const folio = String(payment.external_reference);
  if (folioEsperado && folioEsperado !== folio) return null;

  const sbHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const f = encodeURIComponent(folio);
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?folio=eq.${f}&select=status,total,items,customer_name,customer_email,customer_phone,cupon_codigo&limit=1`, { headers: sbHeaders });
  const rows = pr.ok ? await pr.json().catch(() => []) : [];
  const previo = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!previo) return null;

  const total = Number(previo.total) || 0;
  let estado = estadoDesdePago(payment, total);
  const actual = previo.status || 'Pendiente';
  const yaPagado = PAGADO.includes(actual);

  let cambiar = true;
  if (estado === 'Reembolsado') cambiar = actual !== 'Reembolsado';
  else if (!EDITABLES.includes(actual)) cambiar = false;           // Enviado, Entregado, Cancelado...
  else if (yaPagado && estado !== 'Pago aceptado') cambiar = false; // nunca bajar un pedido pagado
  else if (actual === estado) cambiar = false;
  if (!cambiar) estado = actual === 'Pagado' ? 'Pago aceptado' : actual;

  if (cambiar) {
    await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?folio=eq.${f}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status: estado, payment_method: 'Mercado Pago' })
    });
  }
  // Número y estado del pago en Mercado Pago (para el detalle del pedido),
  // aunque el estado del pedido no cambie.
  if (!yaPagado || payment.status === 'approved' || estado === 'Reembolsado') {
    await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?folio=eq.${f}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        mp_payment_id: String(payment.id || ''), mp_status: payment.status || null,
        // Motivo del estado (p. ej. cc_rejected_insufficient_amount): con
        // esto el admin puede ver POR QUÉ se rechazó un pago.
        mp_status_detail: payment.status_detail ? String(payment.status_detail).slice(0, 100) : null,
        ...(payment.status === 'approved' && payment.date_approved ? { paid_at: payment.date_approved } : {})
      })
    }).catch(() => {});
  }

  // Primera vez que queda pagado: correo de confirmación al cliente y la
  // compra a Meta (event_id = folio, el mismo que usa el navegador).
  if (cambiar && estado === 'Pago aceptado' && !yaPagado) {
    const items = Array.isArray(previo.items) ? previo.items : [];
    // El cupón cuenta como usado solo cuando el pedido quedó pagado.
    if (previo.cupon_codigo) {
      try { await sumarUso(serviceRoleKey, previo.cupon_codigo); } catch (e) { console.error(`cupón ${previo.cupon_codigo}: ${e.message}`); }
    }
    await enviarPushAdmins({
      title: '💰 Pago aceptado',
      body: `Pedido ${folio} de ${previo.customer_name || 'cliente'} por $${Number(total || 0).toFixed(2)}.`,
      url: '/admin', tag: `pago-${folio}`
    });
    if (previo.customer_email && smtpConfigured()) {
      try {
        await sendTemplate(previo.customer_email, 'pedido', { nombre: previo.customer_name || '', pedidoId: folio, total, items });
      } catch (e) { /* el correo es secundario */ }
    }
    try {
      const metaResult = await sendMetaEvent({
        eventName: 'Purchase',
        eventId: folio,
        eventSourceUrl: 'https://www.mifiestashop.com/',
        value: total || Number(payment.transaction_amount) || 0,
        contents: items.map(i => ({ id: i.id, quantity: i.qty })),
        customer: { name: previo.customer_name, email: previo.customer_email, phone: previo.customer_phone }
      });
      // El envío a Meta es secundario (nunca bloquea la confirmación del
      // pedido), pero un fallo silencioso es invisible sin esto: antes no
      // había forma de detectar un token vencido o un pixel mal
      // configurado más que revisando Events Manager a ciegas.
      if (metaResult && metaResult.ok === false) {
        console.error(`Meta CAPI: fallo al reportar Purchase ${folio} (status ${metaResult.status}): ${metaResult.detail}`);
      }
    } catch (e) { console.error(`Meta CAPI: error al reportar Purchase ${folio}: ${e.message}`); }
  }

  return { folio, estado, mpStatus: payment.status, mpStatusDetail: payment.status_detail || null, total };
}

// Busca en Mercado Pago TODOS los intentos de pago de un pedido (por su
// folio = external_reference) y aplica el más relevante: aprobado, luego en
// proceso/pendiente, luego el más reciente. Sirve para los pedidos que se
// quedaron en "Pendiente" porque el aviso de Mercado Pago no llegó, y para
// saber con certeza cuándo el cliente de plano no intentó pagar.
// -> { folio, intentos: [{ id, status, statusDetail, fecha, monto }], aplicado }
async function conciliarPedido({ accessToken, serviceRoleKey, folio }) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(folio)}&sort=date_created&criteria=desc&limit=30`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) throw new Error(`payments/search -> HTTP ${r.status}`);
  const data = await r.json().catch(() => ({}));
  const pagos = (Array.isArray(data.results) ? data.results : [])
    .filter(p => String(p.external_reference || '') === folio);
  const intentos = pagos.map(p => ({
    id: String(p.id), status: p.status || null, statusDetail: p.status_detail || null,
    fecha: p.date_created || null, monto: Number(p.transaction_amount) || 0
  }));
  if (!pagos.length) return { folio, intentos, aplicado: null };
  const elegido = pagos.find(p => p.status === 'approved')
    || pagos.find(p => ['in_process', 'pending', 'authorized'].includes(p.status))
    || pagos[0];
  const aplicado = await aplicarPago({ accessToken, serviceRoleKey, paymentId: String(elegido.id), folioEsperado: folio });
  return { folio, intentos, aplicado };
}

module.exports = { conciliarPedido, aplicarPago, estadoDesdePago };
