// Vercel serverless function: historial real de búsquedas de clientes en la
// tienda pública (tabla busquedas_tienda, alimentada por api/log-busqueda.js)
// — usado por el admin en "Parámetros de la Tienda > Motor de Búsqueda".
const { exigirSesion } = require('../lib/sesion-panel.js');
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

const LLAVE_SERVICIO = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
module.exports = async function handler(req, res) {
  // Datos privados del panel: solo con sesión (lib/sesion-panel.js) y nunca en la caché del CDN.
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await exigirSesion(req, res))) return;

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  try {
    const url = `${SUPABASE_URL}/rest/v1/busquedas_tienda?select=id,query,results_count,created_at&order=created_at.desc&limit=${limit}`;
    const r = await fetch(url, {
      headers: { apikey: LLAVE_SERVICIO(), Authorization: `Bearer ${LLAVE_SERVICIO()}` }
    });
    if (!r.ok) throw new Error(`Supabase error ${r.status}`);
    const rows = await r.json();

    const history = rows.map(row => ({
      id: row.id, query: row.query, resultsCount: row.results_count, date: row.created_at
    }));

    // Top de términos más buscados, calculado sobre las mismas filas ya
    // traídas (no una consulta aparte) — agrupando por texto exacto en
    // minúsculas, que es como ya se guarda la búsqueda.
    const counts = {};
    history.forEach(h => {
      const key = h.query.toLowerCase();
      if (!counts[key]) counts[key] = { query: h.query, count: 0, totalResults: 0 };
      counts[key].count++;
      counts[key].totalResults += h.resultsCount;
    });
    const top = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 10);

    res.status(200).json({ history, top, count: history.length, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, history: [], top: [] });
  }
};
