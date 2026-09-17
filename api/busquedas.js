// Vercel serverless function: historial real de búsquedas de clientes en la
// tienda pública (tabla busquedas_tienda, alimentada por api/log-busqueda.js)
// — usado por el admin en "Parámetros de la Tienda > Motor de Búsqueda".
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  try {
    const url = `${SUPABASE_URL}/rest/v1/busquedas_tienda?select=id,query,results_count,created_at&order=created_at.desc&limit=${limit}`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
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
