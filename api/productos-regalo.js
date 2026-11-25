// Vercel serverless function: ids de los productos marcados "Como regalo" (regalo por reseña en el POS).
// El POS antes solo lo sabía con el catálogo completo del panel (/api/productos-admin, pesado y en segundo
// plano): si la cajera agregaba el producto antes de que terminara de cargar, o si fallaba, lo cobraba sin
// preguntar "¿Vender o Regalo?". Esta lista es chica y se pide al abrir el POS.
// GET -> { ids: [83392, ...] }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

module.exports = async function handler(req, res) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.setHeader('Cache-Control', 'no-store'); res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY' }); return; }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/producto_privado?select=id&regalo_resena=is.true&limit=1000`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ids = (await r.json()).map(x => Number(x.id)).filter(Number.isFinite);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ ids });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'No se pudo leer la lista de regalos.' });
  }
};
