// Vercel serverless function: guarda la cuenta bancaria para pagos por
// transferencia (tabla ajustes_pago, una sola fila). La tienda la lee
// directo de Supabase (lectura pública) para mostrarla al confirmar un
// pedido; el correo del pedido la toma del servidor (lib/correo.js).
//
// La tabla no admite escrituras con la llave pública: solo aquí, con la
// sesión del back office (rpc_check_session) y la llave de servicio.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, datos: {
//   activa, leyenda, titular, banco, cuenta, clabe, instrucciones } }
//   -> { ok: true, ajustes }
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

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  let authorized = false;
  try { authorized = await checkSession(body); } catch (e) { authorized = false; }
  if (!authorized) { res.status(401).json({ error: 'unauthorized' }); return; }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  const d = body.datos && typeof body.datos === 'object' ? body.datos : {};
  const cuenta = clean(d.cuenta, 30).replace(/\s+/g, '');
  const clabe = clean(d.clabe, 30).replace(/\s+/g, '');
  if (clabe && !/^\d{18}$/.test(clabe)) { res.status(400).json({ error: 'La CLABE debe tener 18 dígitos.' }); return; }
  if (cuenta && !/^\d{6,20}$/.test(cuenta)) { res.status(400).json({ error: 'El número de cuenta solo lleva dígitos.' }); return; }

  const row = {
    id: 1,
    transferencia_activa: d.activa !== false,
    transferencia_leyenda: clean(d.leyenda, 120) || null,
    transferencia_titular: clean(d.titular, 200) || null,
    transferencia_banco: clean(d.banco, 80) || null,
    transferencia_cuenta: cuenta || null,
    transferencia_clabe: clabe || null,
    transferencia_instrucciones: clean(d.instrucciones, 500) || null,
    updated_at: new Date().toISOString()
  };

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ajustes_pago?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const saved = await r.json();
    res.status(200).json({ ok: true, ajustes: Array.isArray(saved) ? saved[0] : saved });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo guardar.', detail: String(err.message || err) });
  }
};
