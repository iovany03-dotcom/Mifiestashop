// Vercel serverless function: registra cada búsqueda real que un cliente
// hace en el buscador de la tienda pública (índex.html llama esto desde
// el input de búsqueda, con un debounce, no en cada tecla) — para que
// "Parámetros de la Tienda > Motor de Búsqueda" pueda mostrar un
// historial real de qué está buscando la gente, no datos inventados.
//
// POST /api/log-busqueda
// body: { query: string, resultsCount: number }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

const MAX_QUERY_LEN = 200;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

  const query = String(body.query || '').trim().slice(0, MAX_QUERY_LEN);
  if (query.length < 2) {
    res.status(200).json({ skipped: true });
    return;
  }
  const resultsCount = Number.isFinite(Number(body.resultsCount)) ? Math.max(0, Math.round(Number(body.resultsCount))) : 0;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/busquedas_tienda`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({ query, results_count: resultsCount })
    });
    if (!r.ok) throw new Error(`Supabase error ${r.status}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    // Registrar la búsqueda nunca debe romper la experiencia de búsqueda
    // del cliente — si falla, se ignora en silencio.
    res.status(200).json({ ok: false, error: err.message });
  }
};
