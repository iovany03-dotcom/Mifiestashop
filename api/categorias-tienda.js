// Vercel serverless function: todas las categorías reales de PrestaShop
// (hijas de la categoría raíz "Productos", id 266), con conteo real de
// productos — usado por el panel de "Ver todos los productos" de la tienda
// pública y su barra lateral de categorías. Las categorías se leen de
// nuestra copia en Supabase (ps_categorias, sincronizada cada hora por
// api/cron-sync-prestashop.js — ver lib/sync-prestashop.js), no se
// consulta PrestaShop para la lista en sí, solo para el conteo por
// categoría.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
// Id de la categoría "Productos" en PrestaShop — raíz de todas las
// categorías visibles de la tienda (ver /266-productos).
const PRODUCTS_ROOT_CATEGORY_ID = 266;

// Fallback si Supabase no responde: mismo listado curado que existía antes
// de que las categorías completas se sincronizaran desde PrestaShop.
const FALLBACK_CATEGORIES = [
  { id: 269, name: 'Globos' }, { id: 273, name: 'Batucada' }, { id: 287, name: 'Boda' },
  { id: 279, name: 'Decoración' }, { id: 311, name: 'Despedida de Soltera' }, { id: 304, name: 'Diademas' },
  { id: 271, name: 'Fiesta Mexicana' }, { id: 294, name: 'Graduaciones' }, { id: 274, name: 'Halloween' },
  { id: 296, name: 'Infantiles' }, { id: 303, name: 'Lentes' }, { id: 268, name: 'Luminosos' },
  { id: 285, name: 'Navidad' }, { id: 280, name: 'Pirotecnia Fría' }, { id: 270, name: 'Velas' },
  { id: 286, name: 'Año Nuevo' }, { id: 305, name: 'Sombreros' }, { id: 272, name: 'Poolparty' }
];

async function loadCategoriesFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/ps_categorias?select=id,name&id_parent=eq.${PRODUCTS_ROOT_CATEGORY_ID}&active=eq.true&order=name.asc`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error(`Supabase error ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('sin categorías en Supabase');
  return rows.map(c => ({ id: c.id, name: c.name }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let categories;
  try {
    categories = await loadCategoriesFromSupabase();
  } catch (e) {
    categories = FALLBACK_CATEGORIES;
  }

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, categories: categories.map(c => ({ ...c, count: 0 })) });
    return;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    const results = await Promise.all(categories.map(async (c) => {
      try {
        const fields = '[id,nb_products_recursive]';
        const url = `${baseUrl}/api/categories/${c.id}?display=${encodeURIComponent(fields)}&output_format=JSON`;
        const r = await fetch(url, { headers });
        if (!r.ok) return { ...c, count: 0 };
        const data = await r.json();
        const cat = Array.isArray(data.categories) ? data.categories[0] : data.category;
        const count = parseInt(cat?.nb_products_recursive || 0, 10);
        return { ...c, count };
      } catch (e) {
        return { ...c, count: 0 };
      }
    }));

    res.status(200).json({ categories: results });
  } catch (err) {
    res.status(200).json({ error: err.message, categories: categories.map(c => ({ ...c, count: 0 })) });
  }
};
