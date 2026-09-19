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

// Algunas categorías vienen capturadas en PrestaShop TODO EN MAYÚSCULAS
// (p.ej. "ARTÍCULOS DE XV AÑOS"), distinto del resto ("Globos", "Despedida
// de soltera"...) — se re-castean aquí, en lectura, para que se vean
// consistentes sin tener que escribir de vuelta a PrestaShop ni pelear con
// que el sync horario (ps_categorias) las vuelva a sobreescribir.
function normalizeCategoryName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Mismo listado completo de categorías por producto que usa /api/productos
// para no dejar fuera productos cuya categoría por defecto en PrestaShop es
// otra distinta — si no se suma aquí también, el conteo del sidebar vuelve
// a no coincidir con lo que la navegación por categoría en realidad regresa.
async function fetchMigratedCategoryIds() {
  const PAGE_SIZE = 1000;
  const list = [];
  try {
    let from = 0;
    while (true) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?select=id,category_ids`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${from + PAGE_SIZE - 1}` }
      });
      if (!r.ok) break;
      const rows = await r.json();
      const batch = Array.isArray(rows) ? rows : [];
      list.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  } catch (e) {
    // se queda con lo que ya haya juntado hasta el momento del error
  }
  return list;
}

async function loadCategoriesFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/ps_categorias?select=id,name&id_parent=eq.${PRODUCTS_ROOT_CATEGORY_ID}&active=eq.true&order=name.asc`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error(`Supabase error ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('sin categorías en Supabase');
  return rows.map(c => ({ id: c.id, name: normalizeCategoryName(c.name) }));
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
    const migratedRows = await fetchMigratedCategoryIds();

    // El conteo se calcula con el MISMO criterio que usa /api/productos para
    // navegar por categoría: el filtro exacto de id_category_default en
    // PrestaShop (no nb_products_recursive, que es recursivo e incluye
    // subcategorías) UNIDO con las categorías reales de los productos
    // migrados (category_ids) — un producto puede vivir en varias a la
    // vez, y su categoría por defecto no siempre es la única.
    const results = await Promise.all(categories.map(async (c) => {
      try {
        const filters = `filter[active]=1&filter[id_category_default]=${encodeURIComponent('[' + c.id + ']')}`;
        const url = `${baseUrl}/api/products?display=${encodeURIComponent('[id]')}&${filters}&limit=0,5000&output_format=JSON`;
        const r = await fetch(url, { headers });
        const data = r.ok ? await r.json() : null;
        const defaultIds = data && Array.isArray(data.products) ? data.products.map(p => Number(p.id)) : [];
        const migratedIds = migratedRows
          .filter(row => Array.isArray(row.category_ids) && row.category_ids.map(String).includes(String(c.id)))
          .map(row => Number(row.id));
        const count = new Set([...defaultIds, ...migratedIds]).size;
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
