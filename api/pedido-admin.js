// Vercel serverless function: acciones sobre un pedido desde el detalle del
// pedido en el back office.
//
// Origen del pedido:
//   - "online": pedidos_online (checkout de la tienda y pedidos creados a
//     mano con "+ Crear Pedido").
//   - "pos": pos_tickets (ventas del Sistema POS de esta app).
//   - "prestashop": ps_pedidos, la copia de los pedidos de las cajas de
//     PrestaShop. El sync los vuelve a traer cada hora, así que su estado
//     solo se puede cambiar en PrestaShop; aquí se rechaza.
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
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, origen, folio,
//        estado?, registradoPor? } -> { ok: true, estado?, piezasRegresadas }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const ESTADOS = ['Pendiente', 'Pendiente de pago', 'Pago aceptado', 'Error en el pago', 'En preparación', 'Enviado', 'Entregado', 'Cancelado', 'Reembolsado'];

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

  if (origen === 'prestashop') {
    res.status(409).json({ error: 'Este pedido viene de las cajas de PrestaShop: su estado, cancelación o borrado se hacen en PrestaShop (aquí se vuelve a copiar cada hora).' });
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const api = rest(serviceRoleKey);

  try {
    if (accion === 'estado' || accion === 'cancelar') {
      const estado = accion === 'cancelar' ? 'Cancelado' : String(body.estado || '');
      if (!ESTADOS.includes(estado)) { res.status(400).json({ error: 'Estado no válido.' }); return; }
      if (!await setEstado(api, origen, folio, estado)) { res.status(404).json({ error: 'Pedido no encontrado.' }); return; }
      const piezasRegresadas = estado === 'Cancelado' ? await regresarStock(api, folio, registradoPor) : 0;
      res.status(200).json({ ok: true, estado, piezasRegresadas });
      return;
    }

    if (accion === 'eliminar') {
      const esAdmin = await rpc('rpc_check_admin', { p_password: body.p_admin_password ?? null }).catch(() => false);
      if (!esAdmin) { res.status(403).json({ error: 'Solo el super administrador puede borrar pedidos.' }); return; }
      const piezasRegresadas = await regresarStock(api, folio, registradoPor);
      const table = origen === 'online' ? 'pedidos_online' : 'pos_tickets';
      const rows = await api(`${table}?folio=eq.${encodeURIComponent(folio)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!Array.isArray(rows) || rows.length === 0) { res.status(404).json({ error: 'Pedido no encontrado.' }); return; }
      res.status(200).json({ ok: true, piezasRegresadas });
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo completar la operación.', detail: String(err.message || err).slice(0, 300) });
  }
};
