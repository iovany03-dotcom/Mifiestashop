// Vercel serverless function: recibe las notificaciones (webhooks) que manda
// Mercado Pago cuando cambia el estado de un pago, y actualiza el pedido
// correspondiente en la tabla pedidos_online de Supabase.
//
// Configurado como notification_url al crear la preferencia en
// api/mp-crear-preferencia.js. Mercado Pago llama esta URL con
// ?type=payment&data.id=<paymentId> (o el formato viejo ?topic=payment&id=...).
//
// Requiere la misma variable de entorno que api/mp-crear-preferencia.js:
//   MP_ACCESS_TOKEN
//
// Además requiere, SOLO en esta función:
//   SUPABASE_SERVICE_ROLE_KEY   la "service_role" secret key del proyecto
//                                (Supabase Dashboard > Project Settings > API
//                                Keys) — pedidos_online ya no acepta UPDATE
//                                con la llave anónima (se cerró ese acceso
//                                por seguridad), así que este webhook
//                                necesita la llave con privilegios de
//                                servidor para poder marcar un pedido como
//                                pagado/cancelado. Nunca se expone al cliente.

const { sendMetaEvent } = require('../lib/meta-capi.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

const STATUS_MAP = {
  approved: 'Pagado',
  rejected: 'Cancelado',
  cancelled: 'Cancelado',
  refunded: 'Cancelado',
  charged_back: 'Cancelado',
  pending: 'Pendiente',
  in_process: 'Pendiente',
  authorized: 'Pendiente',
};

module.exports = async function handler(req, res) {
  // Mercado Pago solo necesita un 200 de vuelta; nunca fallar con un status
  // de error o reintentará indefinidamente notificaciones que ya no aplican.
  res.setHeader('Access-Control-Allow-Origin', '*');

  const accessToken = process.env.MP_ACCESS_TOKEN;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const paymentId = req.query['data.id'] || req.query.id || (req.body && req.body.data && req.body.data.id);
  const topic = req.query.type || req.query.topic || (req.body && req.body.type);

  if (!accessToken || !serviceRoleKey || !paymentId || topic !== 'payment') {
    res.status(200).json({ received: true });
    return;
  }

  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payment = await r.json();
    if (!r.ok || !payment.external_reference) {
      res.status(200).json({ received: true });
      return;
    }

    const nuevoStatus = STATUS_MAP[payment.status] || 'Pendiente';
    const folioParam = encodeURIComponent(payment.external_reference);
    const sbHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };

    // Estado y datos del pedido ANTES de actualizarlo: Mercado Pago manda
    // varias notificaciones por el mismo pago, y solo la primera que lo
    // pasa a "Pagado" debe reportar la compra a Meta.
    let previo = null;
    try {
      const pr = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?folio=eq.${folioParam}&select=status,total,items,customer_name,customer_email,customer_phone&limit=1`, { headers: sbHeaders });
      const rows = pr.ok ? await pr.json() : [];
      previo = Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch (e) { /* si falla la lectura, se actualiza igual y no se reporta */ }

    await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?folio=eq.${folioParam}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status: nuevoStatus, payment_method: 'Mercado Pago' }),
    });

    // Compra confirmada -> API de Conversiones de Meta desde el servidor,
    // aunque el cliente cierre la pestaña en Mercado Pago sin regresar al
    // sitio. event_id = folio, el mismo que manda el navegador al volver,
    // para que Meta cuente una sola compra. Nunca hace fallar el webhook.
    if (nuevoStatus === 'Pagado' && previo && previo.status !== 'Pagado') {
      try {
        await sendMetaEvent({
          eventName: 'Purchase',
          eventId: payment.external_reference,
          eventSourceUrl: 'https://mifiestashop.vercel.app/',
          value: Number(previo.total) || Number(payment.transaction_amount) || 0,
          contents: (Array.isArray(previo.items) ? previo.items : []).map(i => ({ id: i.id, quantity: i.qty })),
          customer: { name: previo.customer_name, email: previo.customer_email, phone: previo.customer_phone },
        });
      } catch (e) { /* el reporte a Meta es secundario */ }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    res.status(200).json({ received: true });
  }
};
