// Vercel serverless function: facturación electrónica CFDI 4.0 con Facturama, solo back office
// (sesión de admin/personal; emitir y cancelar facturas tiene efectos fiscales reales).
//
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, ... }
//   accion "estado"    -> { configurado, entorno }
//   accion "pedido"    -> { pedido } datos del pedido/ticket para prellenar la factura { origen, folio }
//   accion "listar"    -> { facturas } últimas facturas emitidas desde aquí
//   accion "emitir"    -> { factura } { origen, pedidoFolio, receptor:{rfc,nombre,cp,regimen,usoCfdi},
//                          items:[{name,sku,qty,price}], formaPago, metodoPago, email? }
//   accion "descargar" -> { contentType, content(base64) } { id, formato: pdf|xml }
//   accion "cancelar"  -> { factura, cancelacion } { id, motivo: 01-04, uuidSustituto? }
//   accion "enviar"    -> { ok } { id, email }
// Facturas guardadas en la tabla `facturas` (docs/supabase-facturas.sql).
const fx = require('../lib/facturama.js');

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
      const folio = String(body.folio || '').trim();
      if (!folio || folio.length > 60) { res.status(400).json({ error: 'Folio inválido.' }); return; }
      const tabla = body.origen === 'online' ? 'pedidos_online' : 'pos_tickets';
      const rows = await api(`${tabla}?folio=eq.${encodeURIComponent(folio)}&select=*&limit=1`);
      const p = rows && rows[0];
      if (!p) { res.status(404).json({ error: 'No se encontró ese folio.' }); return; }
      const items = (Array.isArray(p.items) ? p.items : []).map(it => ({ id: it.id || it.product_id || null, name: it.name, sku: it.sku || '', qty: it.qty || 1, price: it.price || 0 }));
      res.status(200).json({ pedido: { folio: p.folio, total: p.total, email: p.customer_email || null, nombre: p.customer_name || null, items } });
      return;
    }

    if (!fx.facturamaConfigurado()) { res.status(503).json({ error: 'Facturama todavía no está configurado (faltan FACTURAMA_USER, FACTURAMA_PASSWORD y FACTURAMA_EXPEDITION_PLACE en Vercel).' }); return; }

    if (accion === 'emitir') {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100)
        .map(it => ({ name: String(it.name || '').slice(0, 500), sku: String(it.sku || '').slice(0, 100), qty: Number(it.qty), price: Number(it.price) }));
      if (!items.length || items.some(it => !(it.qty > 0) || !(it.price >= 0) || !it.name)) { res.status(400).json({ error: 'Los conceptos necesitan nombre, cantidad y precio válidos.' }); return; }
      const email = body.email ? String(body.email).trim() : '';
      if (email && !EMAIL_RE.test(email)) { res.status(400).json({ error: 'Correo inválido.' }); return; }
      const pedidoFolio = String(body.pedidoFolio || '').trim().slice(0, 60) || null;
      const origen = ['online', 'pos', 'prestashop', 'manual'].includes(body.origen) ? body.origen : 'manual';

      if (pedidoFolio) {
        const previas = await api(`facturas?pedido_folio=eq.${encodeURIComponent(pedidoFolio)}&estado=neq.cancelada&select=uuid,entorno`);
        const real = fx.entorno();
        if (previas.some(f => f.entorno === real)) { res.status(409).json({ error: `El pedido ${pedidoFolio} ya tiene una factura vigente (${previas[0].uuid || 'sin folio fiscal'}). Cancélala primero si hay que rehacerla.` }); return; }
      }

      let cfdi;
      try {
        cfdi = fx.armarCfdi({ receptor: body.receptor, items, formaPago: body.formaPago, metodoPago: body.metodoPago, folio: nuevoFolio(), fecha: fechaMx(), referencia: pedidoFolio });
      } catch (e) { res.status(400).json({ error: e.message }); return; }

      const emitida = await fx.timbrar(cfdi);
      const uuid = emitida && emitida.Complement && emitida.Complement.TaxStamp ? emitida.Complement.TaxStamp.Uuid : null;
      const fila = {
        facturama_id: emitida.Id, uuid, folio: String(emitida.Folio || cfdi.Folio), serie: emitida.Serie || cfdi.Serie || null,
        origen, pedido_folio: pedidoFolio, rfc: cfdi.Receiver.Rfc, nombre: cfdi.Receiver.Name, email: email || null,
        total: Number(emitida.Total != null ? emitida.Total : cfdi.Items.reduce((s, c) => s + c.Total, 0)),
        entorno: fx.entorno(), estado: 'activa', creado_por: String(body.registradoPor || '').slice(0, 80) || null
      };
      let guardada = null, aviso = null;
      try { guardada = (await api('facturas', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([fila]) }))[0]; }
      catch (e) { aviso = 'La factura se timbró pero no se pudo guardar en el listado: ' + e.message; guardada = fila; }
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
      res.status(200).json({ estado, cancelacion: c ? { Status: c.Status, Message: c.Message, IsCancelable: c.IsCancelable } : null });
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    res.status(err.status === 401 ? 502 : (err.status && err.status < 500 ? 422 : 502)).json({ error: String(err.message || err).slice(0, 500) });
  }
};
