// Vercel serverless function: interruptores de la tienda que se cambian
// desde el Dashboard del admin. Se guardan en la misma fila de ajustes_pago
// (lectura pública, así la tienda los lee directo de Supabase); solo se
// escriben aquí, con la sesión del back office y la llave de servicio.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, mostrarStockSucursal }
//   -> { ok: true, mostrarStockSucursal }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function checkSession(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_admin_password: body.p_admin_password ?? null,
      p_staff_email: body.p_staff_email ?? null,
      p_staff_pin: body.p_staff_pin ?? null
    })
  });
  if (!r.ok) return false;
  return !!(await r.json());
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  if (typeof body.mostrarStockSucursal !== 'boolean') { res.status(400).json({ error: 'Falta mostrarStockSucursal (true/false).' }); return; }

  let authorized = false;
  try { authorized = await checkSession(body); } catch (e) { authorized = false; }
  if (!authorized) { res.status(401).json({ error: 'unauthorized' }); return; }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ajustes_pago?id=eq.1`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json', Prefer: 'return=representation'
      },
      body: JSON.stringify({ mostrar_stock_sucursal: body.mostrarStockSucursal, updated_at: new Date().toISOString() })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error('No existe la fila de ajustes (id=1).');
    res.status(200).json({ ok: true, mostrarStockSucursal: !!row.mostrar_stock_sucursal });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo guardar.', detail: String(err.message || err) });
  }
};
