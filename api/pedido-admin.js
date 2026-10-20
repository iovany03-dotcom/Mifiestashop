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
//
// Cada estado, cancelación, borrado y cambio de datos se anota en pedido_historial (lib/pedido-historial.js)
// con el nombre de quien lo hizo (sacado de la sesión en el servidor) y la fecha y hora.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, origen, folio,
//        estado?, registradoPor? } -> { ok: true, estado?, piezasRegresadas, historialRegistrado }
const historial = require('../lib/pedido-historial.js');

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

function rest(key) {
  return async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  };
}

// Compensa en el ledger (pos_stock_moves) todo lo que el pedido movió de
// stock. Devuelve cuántas piezas regresó.
async function regresarStock(api, folio, registradoPor) {
  const moves = await api(`pos_stock_moves?select=id_product,almacen,qty&folio=eq.${encodeURIComponent(folio)}`);
  const net = new Map();
  (Array.isArray(moves) ? moves : []).forEach(m => {
    const key = `${m.id_product}|${m.almacen}`;
    net.set(key, (net.get(key) || 0) + Number(m.qty || 0));
  });
  const reversal = [];
  net.forEach((qty, key) => {
    if (Math.abs(qty) < 1e-9) return;
    const [id_product, almacen] = key.split('|');
    reversal.push({ id_product: Number(id_product), almacen, qty: -qty, motivo: 'cancelacion', folio, registrado_por: registradoPor || 'Admin' });
  });
  if (reversal.length) await api('pos_stock_moves', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(reversal) });
  return reversal.reduce((s, m) => s + Math.max(0, m.qty), 0);
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
