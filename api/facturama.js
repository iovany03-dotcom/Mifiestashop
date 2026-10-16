// Vercel serverless function: facturación electrónica CFDI 4.0 con Facturama, solo back office
// (sesión de admin/personal; emitir y cancelar facturas tiene efectos fiscales reales).
//
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, ... }
//   accion "estado"    -> { configurado, entorno }
//   accion "pedido"    -> { pedido } el pedido/ticket con los conceptos que se van a facturar y si
//                          se puede facturar { origen?, folio }
//   accion "listar"    -> { facturas } últimas facturas emitidas desde aquí
//   accion "emitir"    -> { factura } { origen, pedidoFolio, receptor:{rfc,nombre,cp,regimen,usoCfdi},
//                          formaPago, metodoPago, email? }
//
// Toda factura va vinculada OBLIGATORIAMENTE a un pedido de la tienda (pedidos_online) o a un
// ticket del POS (pos_tickets): los conceptos salen de ese pedido/ticket en el servidor (con su
// envío y su descuento), nunca de lo que mande el navegador, y solo se factura lo pagado. Antes
// el folio era opcional y los conceptos se escribían a mano, así que se podían timbrar facturas
// que no correspondían a ninguna venta.
//   accion "descargar" -> { contentType, content(base64) } { id, formato: pdf|xml }
//   accion "cancelar"  -> { factura, cancelacion } { id, motivo: 01-04, uuidSustituto? }
//   accion "enviar"    -> { ok } { id, email }
// Facturas guardadas en la tabla `facturas` (docs/supabase-facturas.sql).
const fx = require('../lib/facturama.js');
const historial = require('../lib/pedido-historial.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function checkSession(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null })
  });
  if (!r.ok) return false;
  return !!(await r.json());
}

function sb(serviceKey) {
  return async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
}

const PAGADOS = ['Pago aceptado', 'Pagado', 'En preparación', 'Enviado', 'Entregado'];
// Estado que permite facturar un pedido todavía no pagado. La factura sale como pago diferido (PPD, forma 99).
const ANTICIPADA = 'Factura anticipada';
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// "#POS-123", "pos-123" -> origen pos, folio "#POS-123"; cualquier otro -> pedido de la tienda.
function normalizarVenta(origen, folio) {
  let f = String(folio || '').trim().toUpperCase().replace(/\s+/g, '');
  const esPos = origen === 'pos' || (!origen && /^#?POS-/.test(f));
  if (esPos && /^POS-/.test(f)) f = '#' + f;
  return { origen: esPos ? 'pos' : 'online', folio: f };
}

// El pedido/ticket tal como se va a facturar: conceptos (con el envío como concepto aparte y
// el descuento del cupón repartido entre los productos), y si se puede facturar.
async function cargarVenta(api, origenPedido, folioPedido) {
  const { origen, folio } = normalizarVenta(origenPedido, folioPedido);
  if (!folio || folio.length > 60) return { error: 'Folio inválido.', status: 400 };
  const tabla = origen === 'online' ? 'pedidos_online' : 'pos_tickets';
  const rows = await api(`${tabla}?folio=eq.${encodeURIComponent(folio)}&select=*&limit=1`);
  const p = rows && rows[0];
  if (!p) return { error: origen === 'pos' ? `No existe el ticket ${folio} en el POS.` : `No existe el pedido ${folio} en la tienda.`, status: 404 };

  const conceptos = (Array.isArray(p.items) ? p.items : []).map(it => {
    const sku = String(it.sku || '').trim();
    return {
      id: it.id || it.product_id || null,
      name: String(it.name || 'Producto'),
      // El "SKU" del catálogo suele ser una lista de palabras clave: si no es un código corto
      // se usa el id del producto.
      sku: sku && sku.length <= 30 && !/[,\s]/.test(sku) ? sku : String(it.id || it.product_id || ''),
      qty: Number(it.qty) || 1,
      price: Number(it.price) || 0
    };
  }).filter(c => c.qty > 0 && c.price > 0);

  // Ticket del POS con "Aplicar IVA": el POS suma el 16% encima de los precios de los productos
  // (subtotal + IVA = total), o sea que esos precios NO traen IVA. Para que la factura quede con
  // el subtotal de los productos, el IVA del ticket y el total cobrado, se pasan a "con IVA"
  // (el resto del sistema asume precios con IVA incluido) antes de desglosarlos.
  const subtotalTicket = Number(p.subtotal), ivaTicket = Number(p.iva), totalTicket = Number(p.total);
  if (origen === 'pos' && process.env.FACTURAMA_IVA_INCLUIDO !== '0' && ivaTicket > 0
      && Math.abs(subtotalTicket + ivaTicket - totalTicket) <= 1) {
    conceptos.forEach(c => { c.price = c.price * 1.16; });
  }

  // Cupón / descuento del pedido repartido proporcionalmente (el último renglón se lleva el ajuste de centavos).
  const descuento = r2(Number(p.discount_amount) || 0);
  if (descuento > 0 && conceptos.length) {
    const brutoTotal = conceptos.reduce((s, c) => s + c.price * c.qty, 0);
    let repartido = 0;
    conceptos.forEach((c, i) => {
      const d = i === conceptos.length - 1 ? r2(descuento - repartido) : r2(descuento * (c.price * c.qty) / brutoTotal);
      c.descuento = d; repartido = r2(repartido + d);
    });
  }
  const envio = r2(Number(p.shipping_cost) || 0);
  if (origen === 'online' && envio > 0) {
    conceptos.push({ name: `Envío${p.shipping_carrier ? ' (' + p.shipping_carrier + ')' : ''}`, sku: 'ENVIO', qty: 1, price: envio, claveSat: '78102203', unidad: 'Servicio', claveUnidad: 'E48' });
  }

  const total = r2(Number(p.total) || 0);
  const totalConceptos = r2(conceptos.reduce((s, c) => s + c.price * c.qty - (c.descuento || 0), 0));
  const estado = origen === 'online' ? (p.status || 'Pendiente') : (p.estado || 'Cobrado');
  let motivo = null;
  if (origen === 'online' && !PAGADOS.includes(estado) && estado !== ANTICIPADA) motivo = `El pedido ${folio} está "${estado}": solo se facturan pedidos pagados o en estado "${ANTICIPADA}".`;
  else if (origen === 'pos' && /cancel/i.test(estado)) motivo = `El ticket ${folio} está cancelado.`;
  else if (!conceptos.length) motivo = `El ${origen === 'pos' ? 'ticket' : 'pedido'} ${folio} no tiene productos con precio.`;
  else if (Math.abs(totalConceptos - total) > 1) motivo = `Los productos del ${origen === 'pos' ? 'ticket' : 'pedido'} suman $${totalConceptos.toFixed(2)} pero su total es $${total.toFixed(2)}; corrige el ${origen === 'pos' ? 'ticket' : 'pedido'} antes de facturarlo.`;

  return {
    venta: {
      origen, folio, total, estado, conceptos, totalConceptos,
      email: p.customer_email || null, nombre: p.customer_name || p.cliente || null,
      fecha: p.created_at || null, facturable: !motivo, motivo
    }
  };
}

// Folio único por operación: se guarda en la factura y se manda a Facturama (idempotencia).
const nuevoFolio = () => String(Date.now()).slice(-9);
// Fecha del CFDI en hora de México, sin zona (formato de Facturama), 2 minutos atrás por el desfase del SAT.
function fechaMx() {
  const d = new Date(Date.now() - 2 * 60 * 1000);
  return d.toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).replace(' ', 'T');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  let ok = false;
  try { ok = await checkSession(body); } catch (e) { ok = false; }
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const { accion } = body;
  // Quién hace la acción sale de la sesión, no del navegador: va a la factura y al historial del pedido.
  const usuario = (await historial.actorName(body)) || 'Desconocido';
  if (accion === 'estado') { res.status(200).json({ configurado: fx.facturamaConfigurado(), entorno: fx.entorno() }); return; }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const api = sb(serviceKey);

  try {
    if (accion === 'listar') {
      const facturas = await api('facturas?select=*&order=fecha.desc&limit=200');
      res.status(200).json({ facturas, entorno: fx.entorno() });
      return;
    }

    if (accion === 'pedido') {
      const r = await cargarVenta(api, body.origen, body.folio);
      if (r.error) { res.status(r.status).json({ error: r.error }); return; }
      const v = r.venta;
      // ¿Ya tiene una factura vigente (en este mismo entorno de Facturama)?
      const previas = await api(`facturas?pedido_folio=eq.${encodeURIComponent(v.folio)}&estado=neq.cancelada&entorno=eq.${fx.entorno()}&select=uuid,folio,fecha`);
      if (previas.length && v.facturable) { v.facturable = false; v.motivo = `Ya tiene una factura vigente (${previas[0].uuid || previas[0].folio}). Cancélala primero si hay que rehacerla.`; }
      res.status(200).json({ pedido: { ...v, items: v.conceptos } });
      return;
    }

    if (!fx.facturamaConfigurado()) { res.status(503).json({ error: 'Facturama todavía no está configurado (faltan FACTURAMA_USER, FACTURAMA_PASSWORD y FACTURAMA_EXPEDITION_PLACE en Vercel).' }); return; }

    if (accion === 'emitir') {
      if (!String(body.pedidoFolio || '').trim()) {
        res.status(400).json({ error: 'Para facturar hay que vincular la factura a un pedido de la tienda o a un ticket del POS: escribe su folio y dale "Cargar".' });
        return;
      }
      const r = await cargarVenta(api, ['online', 'pos'].includes(body.origen) ? body.origen : null, body.pedidoFolio);
      if (r.error) { res.status(r.status).json({ error: r.error }); return; }
      const venta = r.venta;
      if (!venta.facturable) { res.status(409).json({ error: venta.motivo }); return; }
      const pedidoFolio = venta.folio;
      const origen = venta.origen;
      // Los conceptos salen del pedido/ticket (servidor); lo que mande el navegador se ignora.
      const items = venta.conceptos.slice(0, 100);
      // Pedido en "Factura anticipada" (sin pago todavía): el SAT exige método PPD con forma de pago 99 (por definir).
      const anticipada = venta.estado === ANTICIPADA;
      const email = body.email ? String(body.email).trim() : '';
      if (email && !EMAIL_RE.test(email)) { res.status(400).json({ error: 'Correo inválido.' }); return; }

      const previas = await api(`facturas?pedido_folio=eq.${encodeURIComponent(pedidoFolio)}&estado=neq.cancelada&select=uuid,entorno`);
      const real = fx.entorno();
      if (previas.some(f => f.entorno === real)) { res.status(409).json({ error: `El ${origen === 'pos' ? 'ticket' : 'pedido'} ${pedidoFolio} ya tiene una factura vigente (${previas[0].uuid || 'sin folio fiscal'}). Cancélala primero si hay que rehacerla.` }); return; }

      let cfdi;
      try {
        cfdi = fx.armarCfdi({ receptor: body.receptor, items, formaPago: anticipada ? '99' : body.formaPago, metodoPago: anticipada ? 'PPD' : body.metodoPago, folio: nuevoFolio(), fecha: fechaMx(), referencia: pedidoFolio });
      } catch (e) { res.status(400).json({ error: e.message }); return; }

      const emitida = await fx.timbrar(cfdi);
      const uuid = emitida && emitida.Complement && emitida.Complement.TaxStamp ? emitida.Complement.TaxStamp.Uuid : null;
      const fila = {
        facturama_id: emitida.Id, uuid, folio: String(emitida.Folio || cfdi.Folio), serie: emitida.Serie || cfdi.Serie || null,
        origen, pedido_folio: pedidoFolio, rfc: cfdi.Receiver.Rfc, nombre: cfdi.Receiver.Name, email: email || null,
        total: Number(emitida.Total != null ? emitida.Total : cfdi.Items.reduce((s, c) => s + c.Total, 0)),
        entorno: fx.entorno(), estado: 'activa', creado_por: usuario
      };
      let guardada = null, aviso = null;
      try { guardada = (await api('facturas', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([fila]) }))[0]; }
      catch (e) { aviso = 'La factura se timbró pero no se pudo guardar en el listado: ' + e.message; guardada = fila; }
      const totalFactura = Number(fila.total) || 0;
      await historial.registrar(serviceKey, {
        folio: pedidoFolio, origen, accion: 'factura', usuario,
        detalle: `Factura emitida${uuid ? ` (UUID ${uuid})` : ''} por $${totalFactura.toFixed(2)}${anticipada ? ' · factura anticipada (pago diferido)' : ''}`
      });
      let correo = null;
      if (email) { try { await fx.enviarCorreo(emitida.Id, email, 'Tu factura de Mi Fiestashop'); correo = true; } catch (e) { correo = false; } }
      res.status(200).json({ factura: guardada, correoEnviado: correo, aviso });
      return;
    }

    const id = String(body.id || '').trim();
    if (!/^[\w-]{5,80}$/.test(id)) { res.status(400).json({ error: 'Id de factura inválido.' }); return; }

    if (accion === 'descargar') {
      const formato = body.formato === 'xml' ? 'xml' : 'pdf';
      const d = await fx.descargar(formato, id);
      res.status(200).json({ contentType: formato, content: d && d.Content ? d.Content : '' });
      return;
    }

    if (accion === 'enviar') {
      const email = String(body.email || '').trim();
      if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Correo inválido.' }); return; }
      await fx.enviarCorreo(id, email, 'Tu factura de Mi Fiestashop');
      res.status(200).json({ ok: true });
      return;
    }

    if (accion === 'cancelar') {
      const motivo = String(body.motivo || '');
      if (!['01', '02', '03', '04'].includes(motivo)) { res.status(400).json({ error: 'Motivo de cancelación inválido (01-04).' }); return; }
      const sust = String(body.uuidSustituto || '').trim();
      if (motivo === '01' && !/^[0-9a-fA-F-]{36}$/.test(sust)) { res.status(400).json({ error: 'El motivo 01 requiere el UUID de la factura que la sustituye.' }); return; }
      const c = await fx.cancelar(id, motivo, sust);
      const estado = c && c.Status === 'canceled' ? 'cancelada' : (c && c.Status === 'pending' ? 'pendiente_cancelacion' : 'activa');
      await api(`facturas?facturama_id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ estado, motivo_cancelacion: motivo }) });
      try {
        const f = ((await api(`facturas?facturama_id=eq.${encodeURIComponent(id)}&select=pedido_folio,origen,uuid&limit=1`)) || [])[0];
        if (f && f.pedido_folio) {
          await historial.registrar(serviceKey, {
            folio: f.pedido_folio, origen: f.origen || 'online', accion: 'factura', usuario,
            detalle: `Factura ${f.uuid ? `(UUID ${f.uuid}) ` : ''}${estado === 'cancelada' ? 'cancelada' : (estado === 'pendiente_cancelacion' ? 'con cancelación pendiente del receptor' : 'no se pudo cancelar')} (motivo ${motivo})`
          });
        }
      } catch (e) { /* el historial no impide la cancelación */ }
      res.status(200).json({ estado, cancelacion: c ? { Status: c.Status, Message: c.Message, IsCancelable: c.IsCancelable } : null });
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    res.status(err.status === 401 ? 502 : (err.status && err.status < 500 ? 422 : 502)).json({ error: String(err.message || err).slice(0, 500) });
  }
};
