'use strict';

function config() {
  const url = process.env.SUPABASE_URL || 'https://iuoirslxjcyarvmrqyjd.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en el servidor');
  return { url, key };
}

async function request(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Supabase: HTTP ${response.status}`);
  return response.status === 204 || response.headers.get('content-length') === '0' ? null : response.json();
}

async function all(table, query = 'select=*&order=id.asc') {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await request(`${table}?${query}`, { headers: { Range: `${offset}-${offset + 999}` } });
    if (!Array.isArray(batch)) throw new Error(`Respuesta inválida: ${table}`);
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

async function requireSession(req) {
  if (req.method !== 'POST') return false;
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  const { p_admin_password = null, p_staff_email = null, p_staff_pin = null } = body;
  if (!p_admin_password && !(p_staff_email && p_staff_pin)) return false;
  return (await request('rpc/rpc_check_session', {
    method: 'POST', body: JSON.stringify({ p_admin_password, p_staff_email, p_staff_pin })
  })) === true;
}

module.exports = { config, request, all, requireSession };
