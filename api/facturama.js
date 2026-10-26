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

const { sb, cargarVenta, nuevoFolio, fechaMx, ANTICIPADA } = require('../lib/factura-venta.js');

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
