// Vercel serverless function: cuentas de clientes creadas en la tienda en
// línea (Supabase Auth), para el Directorio de Clientes del admin.
//
// El directorio solo mostraba ps_clientes (la copia de los clientes de
// PrestaShop), así que una cuenta creada en el sitio nuevo nunca aparecía
// ahí aunque sí existiera y estuviera confirmada. Las cuentas viven en
// auth.users, que solo se puede leer con la llave de servicio — por eso
// esto es un endpoint aparte y protegido con la misma sesión de admin /
// personal que el resto del back office (rpc_check_session), en vez de
// sumarse a /api/clientes, que es público.
//
// POST { p_admin_password, p_staff_email, p_staff_pin }
//   -> { customers: [{ id, name, email, rfc, phone, date, active, status, source: 'web' }] }
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

async function listAuthUsers(serviceRoleKey) {
  const PER_PAGE = 1000;
  const users = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!r.ok) throw new Error(`auth admin/users -> HTTP ${r.status}`);
    const data = await r.json();
    const batch = Array.isArray(data.users) ? data.users : [];
    users.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return users;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  let authorized = false;
  try { authorized = await checkSession(body); } catch (e) { authorized = false; }
  if (!authorized) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' });
    return;
  }

  try {
    const users = await listAuthUsers(serviceRoleKey);
    const customers = users
      .filter(u => u.email)
      .map(u => {
        const meta = u.user_metadata || {};
        const confirmed = !!(u.email_confirmed_at || u.confirmed_at);
        return {
          id: 'WEB-' + String(u.id).slice(0, 8).toUpperCase(),
          name: meta.full_name || meta.name || u.email.split('@')[0],
          email: u.email,
          rfc: meta.rfc || '—',
          phone: meta.phone || u.phone || '—',
          date: u.created_at ? String(u.created_at).slice(0, 10) : '—',
          active: confirmed,
          status: confirmed ? 'Activo' : 'Sin confirmar',
          source: 'web'
        };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.status(200).json({ customers, count: customers.length });
  } catch (err) {
    res.status(502).json({ error: 'No se pudieron leer las cuentas web', detail: String(err.message || err) });
  }
};
