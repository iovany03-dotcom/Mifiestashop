// Vercel serverless function: lee las categorías desde nuestra propia copia
// en Supabase (ps_categorias), sincronizada cada hora por
// api/cron-sync-prestashop.js — ya no se consulta PrestaShop en cada carga.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const url = `${SUPABASE_URL}/rest/v1/ps_categorias?select=id,name&active=eq.true&order=name.asc`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!r.ok) throw new Error(`Supabase error ${r.status}`);

    const rawCats = await r.json();
    const categories = rawCats
      .map(c => ({ id: c.id, name: c.name || `Categoría ${c.id}` }))
      .filter(c => c.name.toLowerCase() !== 'inicio' && c.name.toLowerCase() !== 'home');

    res.status(200).json({ categories, source: 'supabase' });
  } catch (err) {
    res.status(200).json({
      fallback: true,
      error: err.message,
      categories: [
        { id: 1, name: 'Globos' },
        { id: 2, name: 'Desechables' },
        { id: 3, name: 'Velas & Pastel' },
        { id: 4, name: 'Disfraces' },
        { id: 5, name: 'Decoración' }
      ]
    });
  }
};
