// Lectura de productos que viven en catalogo_productos (el catálogo propio,
// donde guarda el admin los productos nuevos con ids fuera del rango de
// PrestaShop). Se usa como respaldo para los ids que PrestaShop no devuelve.
// La tabla permite SELECT con la llave anónima.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function fetchCatalogoByIds(ids) {
  const clean = [...new Set((ids || []).map(String).filter(s => /^\d+$/.test(s)))].slice(0, 60);
  if (!clean.length) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/catalogo_productos?select=id,name,sku,price,description,description_short,link_rewrite,legacy_image_url,images&active=eq.true&id=in.(${clean.join(',')})`;
    const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

module.exports = { fetchCatalogoByIds };
