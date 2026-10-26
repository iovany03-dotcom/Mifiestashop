// Vercel serverless function: autofactura para clientes (página /facturar, sin sesión).
//
// El cliente escribe el folio de su ticket del POS y el total que pagó (los folios son números
// de 5 cifras: con el total nadie puede facturar el ticket de otra persona adivinando folios).
// Solo se factura un ticket que se cobró CON IVA ("Aplicar IVA" en el POS); uno sin IVA no.
//
// POST { accion, folio, total, ... }
//   accion "buscar"    -> { ticket } { folio, total }: lo que se va a facturar y si se puede
//   accion "emitir"    -> { factura } { folio, total, receptor:{rfc,nombre,cp,regimen,usoCfdi},
//                          email, formaPago? (solo si pagó con tarjeta: 04 crédito / 28 débito) }
//   accion "descargar" -> { contentType, content(base64) } { folio, total, rfc, formato: pdf|xml }
//                          de un ticket que ya se facturó a ese RFC
//
// AUTOFACTURA_DIAS (Vercel, opcional): días que tiene el cliente para facturar (default 30).
const fx = require('../lib/facturama.js');
const historial = require('../lib/pedido-historial.js');
const { sb, cargarVenta, nuevoFolio, fechaMx, r2 } = require('../lib/factura-venta.js');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORMA_PAGO = { cash: '01', transfer: '03', card: '04' };
const NOMBRE_FORMA = { '01': 'Efectivo', '03': 'Transferencia', '04': 'Tarjeta de crédito', '28': 'Tarjeta de débito' };
const USUARIO = 'Autofactura (cliente)';

class ErrorCliente extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const diasMax = () => { const n = parseInt(process.env.AUTOFACTURA_DIAS, 10); return n > 0 ? n : 30; };

// El ticket con su folio Y su total; si no coinciden, el mismo mensaje (no se revela si el folio existe).
async function ticketDelCliente(api, folioTxt, totalTxt) {
  const digitos = String(folioTxt || '').replace(/\D/g, '');
  const total = Number(String(totalTxt || '').replace(/[$,\s]/g, ''));
  if (!/^\d{3,9}$/.test(digitos) || !(total > 0)) throw new ErrorCliente(400, 'Escribe el número de ticket y el total que pagaste, tal como vienen en tu ticket.');
  const folio = `#POS-${digitos}`;
  const filas = await api(`pos_tickets?folio=eq.${encodeURIComponent(folio)}&total=gte.${r2(total - 0.5)}&total=lte.${r2(total + 0.5)}&select=folio,iva,total,subtotal,metodo,estado,created_at,almacen&order=created_at.desc&limit=1`);
  const t = filas && filas[0];
  if (!t) throw new ErrorCliente(404, 'No encontramos un ticket con ese número y ese total. Revisa que sean los de tu ticket (el total con centavos).');
  return t;
}

// ¿Se puede facturar? Devuelve el ticket listo para mostrar al cliente (sin datos de otras personas).
async function revisar(api, body) {
  const t = await ticketDelCliente(api, body.folio, body.total);
  const r = await cargarVenta(api, 'pos', t.folio);
  if (r.error) throw new ErrorCliente(r.status, r.error);
  const v = r.venta;
  let motivo = null, yaFacturado = false;
  const dias = (Date.now() - new Date(t.created_at).getTime()) / 86400000;
  if (!(Number(t.iva) > 0)) motivo = 'Este ticket se cobró sin IVA, por eso no se puede facturar. Si necesitas factura, pídela en caja antes de pagar para que te cobren el IVA.';
  else if (/cancel/i.test(t.estado || '')) motivo = 'Este ticket está cancelado.';
  else if (dias > diasMax()) motivo = `El ticket es de hace más de ${diasMax()} días. Para facturarlo comunícate con nosotros por WhatsApp.`;
  else if (!v.facturable) motivo = 'No se puede facturar este ticket en línea. Comunícate con nosotros por WhatsApp y te ayudamos.';
  else {
    const previas = await api(`facturas?pedido_folio=eq.${encodeURIComponent(t.folio)}&estado=neq.cancelada&entorno=eq.${fx.entorno()}&select=id&limit=1`);
    if (previas.length) { yaFacturado = true; motivo = 'Este ticket ya está facturado. Si la factura es tuya, puedes descargarla con tu RFC.'; }
  }
  return {
    t, v,
    ticket: {
      folio: t.folio, fecha: t.created_at, sucursal: t.almacen || null, metodo: t.metodo,
      subtotal: r2(t.subtotal), iva: r2(t.iva), total: r2(t.total),
      conceptos: v.conceptos.map(c => ({ nombre: c.name, cantidad: c.qty, importe: r2(c.price * c.qty - (c.descuento || 0)) })),
      facturable: !motivo, ya_facturado: yaFacturado, motivo,
      tarjeta: t.metodo === 'card'
    }
  };
}

async function emitir(api, serviceKey, body) {
  const { t, v, ticket } = await revisar(api, body);
  if (!ticket.facturable) throw new ErrorCliente(409, ticket.motivo);
  const email = String(body.email || '').trim();
  if (!EMAIL_RE.test(email)) throw new ErrorCliente(400, 'Escribe un correo válido: ahí te llega la factura.');
  // La forma de pago sale del ticket; con tarjeta el cliente elige si fue de crédito o débito.
  let formaPago = FORMA_PAGO[t.metodo] || '99';
  if (t.metodo === 'card' && ['04', '28'].includes(String(body.formaPago))) formaPago = String(body.formaPago);

  let cfdi;
  try {
    cfdi = fx.armarCfdi({ receptor: body.receptor, items: v.conceptos.slice(0, 100), formaPago, metodoPago: 'PUE', folio: nuevoFolio(), fecha: fechaMx(), referencia: t.folio });
  } catch (e) { throw new ErrorCliente(400, e.message); }

  const emitida = await fx.timbrar(cfdi);
  const uuid = emitida && emitida.Complement && emitida.Complement.TaxStamp ? emitida.Complement.TaxStamp.Uuid : null;
  const fila = {
    facturama_id: emitida.Id, uuid, folio: String(emitida.Folio || cfdi.Folio), serie: emitida.Serie || cfdi.Serie || null,
    origen: 'pos', pedido_folio: t.folio, rfc: cfdi.Receiver.Rfc, nombre: cfdi.Receiver.Name, email,
    total: Number(emitida.Total != null ? emitida.Total : cfdi.Items.reduce((s, c) => s + c.Total, 0)),
    entorno: fx.entorno(), estado: 'activa', creado_por: USUARIO
  };
  try { await api('facturas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([fila]) }); }
  catch (e) { console.error('autofactura: timbrada pero no guardada', t.folio, uuid, e.message); }
  await historial.registrar(serviceKey, {
    folio: t.folio, origen: 'pos', accion: 'factura', usuario: USUARIO,
    detalle: `Factura emitida por el cliente en línea${uuid ? ` (UUID ${uuid})` : ''} a ${cfdi.Receiver.Rfc} por $${(Number(fila.total) || 0).toFixed(2)}`
  }).catch(() => {});
  let correoEnviado = false;
  try { await fx.enviarCorreo(emitida.Id, email, 'Tu factura de Mi Fiestashop'); correoEnviado = true; } catch (e) { /* se puede descargar */ }
  return { factura: { uuid, folio: fila.folio, serie: fila.serie, rfc: fila.rfc, total: fila.total, forma_pago: NOMBRE_FORMA[formaPago] || formaPago }, correoEnviado };
}

async function descargar(api, body) {
  const t = await ticketDelCliente(api, body.folio, body.total);
  const rfc = String(body.rfc || '').trim().toUpperCase();
  const f = ((await api(`facturas?pedido_folio=eq.${encodeURIComponent(t.folio)}&estado=neq.cancelada&entorno=eq.${fx.entorno()}&select=facturama_id,rfc&limit=1`)) || [])[0];
  if (!f || !rfc || f.rfc !== rfc) throw new ErrorCliente(404, 'No hay una factura de este ticket con ese RFC.');
  const formato = body.formato === 'xml' ? 'xml' : 'pdf';
  const d = await fx.descargar(formato, f.facturama_id);
  return { contentType: formato, content: d && d.Content ? d.Content : '' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ error: 'La facturación en línea no está disponible por ahora.' }); return; }
  const api = sb(serviceKey);
  try {
    if (body.accion === 'buscar') { res.status(200).json({ ticket: (await revisar(api, body)).ticket }); return; }
    if (!fx.facturamaConfigurado()) { res.status(503).json({ error: 'La facturación en línea no está disponible por ahora. Escríbenos por WhatsApp.' }); return; }
    if (body.accion === 'emitir') { res.status(200).json(await emitir(api, serviceKey, body)); return; }
    if (body.accion === 'descargar') { res.status(200).json(await descargar(api, body)); return; }
    res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (e) {
    if (e instanceof ErrorCliente) { res.status(e.status).json({ error: e.message }); return; }
    // Errores de Facturama (RFC que no coincide con el SAT, régimen que no corresponde, etc.): se le
    // muestran al cliente para que corrija sus datos.
    const msg = String(e.message || e);
    res.status(/^Facturama 4\d\d/.test(msg) ? 422 : 502).json({ error: /^Facturama 4\d\d/.test(msg) ? `El SAT rechazó los datos: ${msg.replace(/^Facturama \d+:?\s*/, '')}` : 'No se pudo generar la factura. Intenta de nuevo en unos minutos.' });
  }
};
