// Vercel serverless function: direcciones de clientes (copia de PrestaShop en ps_direcciones, vía la vista direcciones_clientes,
// sincronizada por lib/sync-prestashop.js, dominio "direcciones"; ver docs/supabase-direcciones.sql). Tienen datos personales, así que
// solo se leen con la llave de servicio y después de validar la sesión del admin/personal.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, q?, offset?, limit?, incluirEliminadas? }
//   -> { rows: [...], total, offset, limit, sincronizado }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const CAMPOS = 'id,id_customer,cliente_nombre,cliente_email,alias,nombre,empresa,direccion,direccion2,cp,ciudad,estado,pais,id_state,id_country,telefono,celular,rfc,referencia,eliminada,date_add';
const BUSCAR_EN = ['cliente_nombre', 'cliente_email', 'nombre', 'empresa', 'alias', 'direccion', 'direccion2', 'cp', 'ciudad', 'estado', 'telefono', 'celular'];

async function checkSession(b) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: b.p_admin_password ?? null, p_staff_email: b.p_staff_email ?? null, p_staff_pin: b.p_staff_pin ?? null })
  });
  return r.ok && !!(await r.json());
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  if (!(await checkSession(body).catch(() => false))) { res.status(401).json({ error: 'unauthorized' }); return; }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(body.offset, 10) || 0, 0);
  // Se quitan los caracteres con significado en PostgREST para que la búsqueda no rompa el filtro.
  const q = String(body.q || '').replace(/[,()*%\\"]/g, ' ').trim().slice(0, 80);

  let url = `${SUPABASE_URL}/rest/v1/direcciones_clientes?select=${CAMPOS}&order=id.desc`;
  if (!body.incluirEliminadas) url += '&eliminada=is.false';
  if (q) url += `&or=(${BUSCAR_EN.map(c => `${c}.ilike.*${encodeURIComponent(q)}*`).join(',')})`;

  try {
    const r = await fetch(url, { headers: { ...h, Range: `${offset}-${offset + limit - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact' } });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      res.status(502).json({ error: r.status === 404 || /direcciones_clientes/.test(detail) ? 'Falta la vista direcciones_clientes en Supabase (ver docs/supabase-direcciones.sql).' : `Supabase error ${r.status}`, detail });
      return;
    }
    const rows = await r.json();
    const range = r.headers.get('content-range') || '';
    const total = parseInt(range.split('/')[1], 10);

    let sincronizado = null;
    try {
      const s = await fetch(`${SUPABASE_URL}/rest/v1/ps_sync_estado?dominio=eq.direcciones&select=last_synced_at,ultimo_resultado`, { headers: h });
      const srows = s.ok ? await s.json() : [];
      if (srows[0]) sincronizado = { cuando: srows[0].last_synced_at, resultado: srows[0].ultimo_resultado };
    } catch (e) { /* solo informativo */ }

    res.status(200).json({ rows, total: Number.isFinite(total) ? total : rows.length, offset, limit, sincronizado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
