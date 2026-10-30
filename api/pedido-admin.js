// Vercel serverless function: acciones sobre un pedido desde el detalle del
// pedido en el back office.
//
// Origen del pedido:
//   - "online": pedidos_online (checkout de la tienda y pedidos creados a
//     mano con "+ Crear Pedido").
//   - "pos": pos_tickets (ventas del Sistema POS de esta app).
//   - "prestashop": ps_pedidos, el histórico de los pedidos de las cajas de
//     PrestaShop (ya desconectado): solo lectura, aquí se rechaza.
//
// Acciones:
//   - estado:   cambia el estado. Si el nuevo estado es "Cancelado" hace lo
//               mismo que cancelar.
//   - cancelar: estado "Cancelado" y regresa el stock que descontó el pedido
//               (los movimientos con su folio en pos_stock_moves se
//               compensan con uno de motivo "cancelacion"; si ya estaba
//               regresado, no hace nada — se puede llamar dos veces).
//   - eliminar: SOLO el super administrador (contraseña de admin, no
//               personal). Regresa el stock igual que cancelar y borra el
//               pedido.
//
//   - datos:     nota interna, fecha de entrega y guía (pedidos de la tienda).
//   - historial: lista el historial de movimientos del pedido (cualquier origen).
//   - resena_regalo: (solo tickets del POS) adjunta o quita la reseña que dejó el cliente por un producto de regalo.
//               { linea (posición en items), url?, comentario?, imagen?: {media_type, data (base64)}, quitar? }
//
// Cada estado, cancelación, borrado y cambio de datos se anota en pedido_historial (lib/pedido-historial.js)
// con el nombre de quien lo hizo (sacado de la sesión en el servidor) y la fecha y hora.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, origen, folio,
//        estado?, registradoPor? } -> { ok: true, estado?, piezasRegresadas, historialRegistrado }
const historial = require('../lib/pedido-historial.js');
const { rest, regresarStock } = require('../lib/pedido-stock.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
// "Factura anticipada": permite facturar el pedido aunque todavía no esté pagado (ver api/facturama.js);
// no cuenta como venta cobrada. Cuando se paga se cambia a Pago aceptado (o lo hace Mercado Pago solo).
const ESTADOS = ['Pendiente', 'Pendiente de pago', 'Factura anticipada', 'Pago aceptado', 'Error en el pago', 'En preparación', 'Enviado', 'Entregado', 'Cancelado', 'Reembolsado'];

async function rpc(fn, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) return false;
  return !!(await r.json());
}

// Valores del pedido ANTES del cambio, para escribir en el historial "de qué a qué". Si no se pueden
// leer, el cambio igual se hace y el historial queda sin el valor anterior.
async function leerPedido(api, origen, folio) {
  try {
    const table = origen === 'online' ? 'pedidos_online' : 'pos_tickets';
    const cols = origen === 'online' ? 'status,nota,delivery_date,tracking_number' : 'estado';
    const rows = await api(`${table}?folio=eq.${encodeURIComponent(folio)}&select=${cols}&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    return null;
  }
}
const estadoActual = (origen, row) => row ? (origen === 'online' ? (row.status || 'Pendiente') : (row.estado || 'Pago aceptado')) : null;
const fmtFecha = v => (v ? String(v).slice(0, 10) : '—');

async function setEstado(api, origen, folio, estado) {
  const f = encodeURIComponent(folio);
  const table = origen === 'online' ? 'pedidos_online' : 'pos_tickets';
  const column = origen === 'online' ? 'status' : 'estado';
  const rows = await api(`${table}?folio=eq.${f}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ [column]: estado }) });
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  const { accion, origen } = body;
  const folio = String(body.folio || '').trim();
  const registradoPor = String(body.registradoPor || '').slice(0, 80);
  if (!folio || folio.length > 60) { res.status(400).json({ error: 'Folio inválido.' }); return; }
  if (!['online', 'pos', 'prestashop'].includes(origen)) { res.status(400).json({ error: 'Origen inválido.' }); return; }

  const session = await rpc('rpc_check_session', {
    p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null
  }).catch(() => false);
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return; }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Historial de movimientos del pedido: quién hizo cada cambio, qué y cuándo.
  if (accion === 'historial') {
    if (!serviceKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
    try { res.status(200).json({ historial: await historial.listar(serviceKey, folio) }); }
    catch (e) { res.status(502).json({ error: 'No se pudo leer el historial.', detail: String(e.message || e).slice(0, 200) }); }
    return;
  }

  if (origen === 'prestashop') {
    res.status(409).json({ error: 'Este pedido es del histórico de las cajas de PrestaShop: es solo de consulta, no se puede cambiar su estado, cancelar ni borrar.' });
    return;
  }

  const usuario = (await historial.actorName(body)) || 'Desconocido';
  const serviceRoleKey = serviceKey;
  if (!serviceRoleKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const api = rest(serviceRoleKey);

  try {
    if (accion === 'estado' || accion === 'cancelar') {
      const estado = accion === 'cancelar' ? 'Cancelado' : String(body.estado || '');
      if (!ESTADOS.includes(estado)) { res.status(400).json({ error: 'Estado no válido.' }); return; }
      const de = estadoActual(origen, await leerPedido(api, origen, folio));
      if (!await setEstado(api, origen, folio, estado)) { res.status(404).json({ error: 'Pedido no encontrado.' }); return; }
      const piezasRegresadas = estado === 'Cancelado' ? await regresarStock(api, folio, registradoPor || usuario) : 0;
      let historialRegistrado = true;
      if (de !== estado || piezasRegresadas > 0) {
        const piezas = piezasRegresadas > 0 ? ` · se regresaron ${piezasRegresadas} piezas al stock` : '';
        historialRegistrado = await historial.registrar(serviceRoleKey, {
          folio, origen, accion, usuario,
          detalle: accion === 'cancelar' ? `Pedido cancelado${de ? ` (estaba en "${de}")` : ''}${piezas}` : `Estado: ${de || '—'} → ${estado}${piezas}`
        });
      }
      res.status(200).json({ ok: true, estado, piezasRegresadas, historialRegistrado });
      return;
    }

    // Nota interna, fecha de entrega y guía de la paquetería (solo pedidos
    // de la tienda en línea / manuales).
    if (accion === 'datos') {
      if (origen !== 'online') { res.status(400).json({ error: 'Solo se pueden editar pedidos de la tienda en línea o manuales.' }); return; }
      const patch = {};
      if (body.nota !== undefined) patch.nota = String(body.nota || '').slice(0, 2000) || null;
      if (body.deliveryDate !== undefined) {
        const d = body.deliveryDate ? String(body.deliveryDate) : null;
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) { res.status(400).json({ error: 'Fecha inválida.' }); return; }
        patch.delivery_date = d;
      }
      if (body.trackingNumber !== undefined) patch.tracking_number = String(body.trackingNumber || '').trim().slice(0, 100) || null;
      if (!Object.keys(patch).length) { res.status(400).json({ error: 'Nada que guardar.' }); return; }
      const antes = (await leerPedido(api, 'online', folio)) || {};
      const rows = await api(`pedidos_online?folio=eq.${encodeURIComponent(folio)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      if (!Array.isArray(rows) || rows.length === 0) { res.status(404).json({ error: 'Pedido no encontrado.' }); return; }
      const cambios = [];
      if (patch.nota !== undefined && (antes.nota || null) !== patch.nota) cambios.push('Nota interna actualizada');
      if (patch.delivery_date !== undefined && fmtFecha(antes.delivery_date) !== fmtFecha(patch.delivery_date)) cambios.push(`Fecha de entrega: ${fmtFecha(antes.delivery_date)} → ${fmtFecha(patch.delivery_date)}`);
      if (patch.tracking_number !== undefined && (antes.tracking_number || null) !== patch.tracking_number) cambios.push(`Guía de rastreo: ${antes.tracking_number || '—'} → ${patch.tracking_number || '—'}`);
      const historialRegistrado = await historial.registrar(serviceRoleKey, cambios.map(detalle => ({ folio, origen, accion: 'datos', detalle, usuario })));
      res.status(200).json({ ok: true, historialRegistrado });
      return;
    }

    // Reseña por un regalo del POS: el ticket lleva líneas con regalo:true (ver confirmPOSSale); aquí se
    // adjunta después la reseña que dejó el cliente (liga, comentario y/o captura) o se quita.
    if (accion === 'resena_regalo') {
      if (origen !== 'pos') { res.status(400).json({ error: 'Los regalos por reseña son de los tickets del POS.' }); return; }
      const rows = await api(`pos_tickets?folio=eq.${encodeURIComponent(folio)}&select=items&limit=1`);
      const items = Array.isArray(rows) && rows[0] && Array.isArray(rows[0].items) ? rows[0].items : null;
      if (!items) { res.status(404).json({ error: 'Ticket no encontrado.' }); return; }
      const idx = Number(body.linea);
      if (!Number.isInteger(idx) || !items[idx] || items[idx].regalo !== true) { res.status(400).json({ error: 'Esa línea no es un regalo por reseña.' }); return; }
      const it = items[idx];
      if (body.quitar === true) {
        delete it.resena;
        await api(`pos_tickets?folio=eq.${encodeURIComponent(folio)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ items }) });
        const historialRegistrado = await historial.registrar(serviceRoleKey, { folio, origen, accion: 'resena_regalo', usuario, detalle: `Se quitó la reseña del regalo "${it.name}"` });
        res.status(200).json({ ok: true, resena: null, historialRegistrado });
        return;
      }
      const url = String(body.url || '').trim();
      const comentario = String(body.comentario || '').trim().slice(0, 1000);
      if (url && !/^https:\/\/[^\s"'<>]+$/i.test(url)) { res.status(400).json({ error: 'La liga de la reseña debe empezar con https://' }); return; }
      let imagen = it.resena && it.resena.imagen || null;
      if (body.imagen && body.imagen.data) {
        const tipo = String(body.imagen.media_type || '');
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[tipo];
        if (!ext) { res.status(400).json({ error: 'La captura debe ser JPG, PNG o WEBP.' }); return; }
        const bytes = Buffer.from(String(body.imagen.data), 'base64');
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) { res.status(400).json({ error: 'La captura debe pesar menos de 3 MB.' }); return; }
        const ruta = `resenas/${folio.replace(/[^A-Za-z0-9-]/g, '')}-${Date.now().toString(36)}.${ext}`;
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/assets/${ruta}`, {
          method: 'POST', headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': tipo }, body: bytes
        });
        if (!up.ok) { res.status(502).json({ error: `No se pudo guardar la captura (HTTP ${up.status}).` }); return; }
        imagen = `${SUPABASE_URL}/storage/v1/object/public/assets/${ruta}`;
      }
      if (!url && !comentario && !imagen) { res.status(400).json({ error: 'Agrega la liga, el comentario o la captura de la reseña.' }); return; }
      it.resena = { url: url || null, comentario: comentario || null, imagen, por: usuario, fecha: new Date().toISOString() };
      await api(`pos_tickets?folio=eq.${encodeURIComponent(folio)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ items }) });
      const historialRegistrado = await historial.registrar(serviceRoleKey, { folio, origen, accion: 'resena_regalo', usuario, detalle: `Reseña adjunta por el regalo "${it.name}"` });
      res.status(200).json({ ok: true, resena: it.resena, historialRegistrado });
      return;
    }

    if (accion === 'eliminar') {
      const esAdmin = await rpc('rpc_check_admin', { p_password: body.p_admin_password ?? null }).catch(() => false);
      if (!esAdmin) { res.status(403).json({ error: 'Solo el super administrador puede borrar pedidos.' }); return; }
      const de = estadoActual(origen, await leerPedido(api, origen, folio));
      const piezasRegresadas = await regresarStock(api, folio, registradoPor || usuario);
      const table = origen === 'online' ? 'pedidos_online' : 'pos_tickets';
      const rows = await api(`${table}?folio=eq.${encodeURIComponent(folio)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!Array.isArray(rows) || rows.length === 0) { res.status(404).json({ error: 'Pedido no encontrado.' }); return; }
      const historialRegistrado = await historial.registrar(serviceRoleKey, {
        folio, origen, accion: 'eliminar', usuario,
        detalle: `Pedido borrado${de ? ` (estaba en "${de}")` : ''}${piezasRegresadas > 0 ? ` · se regresaron ${piezasRegresadas} piezas al stock` : ''}`
      });
      res.status(200).json({ ok: true, piezasRegresadas, historialRegistrado });
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo completar la operación.', detail: String(err.message || err).slice(0, 300) });
  }
};
