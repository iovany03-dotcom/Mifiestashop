// TEMPORAL: corrige el stock negativo real de 4 productos en la bodega de
// Querétaro (id_warehouse=56) — se detectaron en negativo (probable
// sobreventa antes de tener el conteo real). Gated por sesión real de
// staff/admin. Se borra después de usarse una sola vez.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function sbRpcServer(fnName, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) throw new Error(`RPC ${fnName} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (e) {}
  } else if (req.method === 'GET' && req.query.payload) {
    try { body = JSON.parse(req.query.payload); } catch (e) {}
  } else {
    res.status(405).json({ error: 'Método no permitido' }); return;
  }

  const p_admin_password = body.p_admin_password ?? null;
  const p_staff_email = body.p_staff_email ?? null;
  const p_staff_pin = body.p_staff_pin ?? null;
  let session = false;
  try { session = await sbRpcServer('rpc_check_session', { p_admin_password, p_staff_email, p_staff_pin }); }
  catch (e) { res.status(401).json({ error: 'unauthorized', detail: e.message }); return; }
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return; }

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  async function psGet(path) {
    const r = await fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}output_format=JSON`, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }
  async function psWrite(method, path, xmlBody) {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { ...headers, 'Content-Type': 'text/xml' }, body: xmlBody });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 600)}`);
    return text;
  }

  const PRODUCT_IDS = [84515, 84516, 83317, 83693];
  const WAREHOUSE_ID = 56;

  if (req.query.mode === 'inspect') {
    try {
      const synopsis = await fetch(`${baseUrl}/api/stocks?schema=synopsis`, { headers });
      const synText = await synopsis.text();
      const rows = await psGet(`/api/stocks?filter[id_warehouse]=${WAREHOUSE_ID}&filter[id_product]=[${PRODUCT_IDS.join('|')}]&display=full`);
      res.status(200).json({ synopsis: synText.slice(0, 3000), rows });
    } catch (e) { res.status(200).json({ error: e.message }); }
    return;
  }

  if (req.query.mode === 'inspectMovements') {
    try {
      const synopsis = await fetch(`${baseUrl}/api/stock_movements?schema=synopsis`, { headers });
      const synText = await synopsis.text();
      const reasons = await psGet('/api/stock_mvt_reasons?display=full&limit=0,30');
      res.status(200).json({ synopsis: synText.slice(0, 3000), reasons });
    } catch (e) { res.status(200).json({ error: e.message }); }
    return;
  }

  const results = [];
  for (const pid of PRODUCT_IDS) {
    try {
      const data = await psGet(`/api/stocks?filter[id_warehouse]=${WAREHOUSE_ID}&filter[id_product]=${pid}&display=full`);
      const rows = Array.isArray(data.stocks) ? data.stocks : [data.stocks].filter(Boolean);
      const row = rows[0];
      if (!row) { results.push({ pid, ok: false, detail: 'no encontrado' }); continue; }
      // real_quantity es read_only según el synopsis real (?schema=synopsis) —
      // no se manda en el PUT.
      const fields = Object.entries(row).filter(([k]) => k !== 'associations' && k !== 'real_quantity').map(([k, v]) => {
        if (k === 'physical_quantity' || k === 'usable_quantity') return `    <${k}>0</${k}>`;
        return `    <${k}>${typeof v === 'string' ? v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : v}</${k}>`;
      }).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">\n  <stock>\n${fields}\n  </stock>\n</prestashop>`;
      await psWrite('PUT', `/api/stocks/${row.id}`, xml);
      results.push({ pid, ok: true, stockId: row.id });
    } catch (e) { results.push({ pid, ok: false, detail: e.message.slice(0, 400) }); }
  }
  res.status(200).json({ results });
};
