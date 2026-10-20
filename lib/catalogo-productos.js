// Lectura de productos de catalogo_productos por id (paquetes de promoción) y
// de sus fotos propias. La tabla permite SELECT con la llave anónima.
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

// Fotos propias (Supabase Storage) por id de producto: { "83341": [url, ...] }.
async function fetchCatalogoImages(ids) {
  const map = {};
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  try {
    const clean = [...new Set((ids || []).map(String).filter(s => /^\d+$/.test(s)))];
    for (let i = 0; i < clean.length; i += 200) {
      const chunk = clean.slice(i, i + 200);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/catalogo_productos?select=id,images&images=not.is.null&id=in.(${chunk.join(',')})`, { headers });
      if (!r.ok) continue;
      const rows = await r.json();
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (Array.isArray(row.images) && row.images.length) map[String(row.id)] = row.images;
      });
    }
  } catch (e) {
    // se queda con lo que haya juntado
  }
  return map;
}

module.exports = { fetchCatalogoByIds, fetchCatalogoImages };
