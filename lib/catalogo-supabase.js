// Lecturas compartidas del catálogo en Supabase (llave anon, solo tablas
// públicas). Todo el sitio, el checkout, el POS y la API pública salen de
// aquí — PrestaShop quedó desconectado por completo y ya no se consulta ni
// se sincroniza.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// Lee todas las filas de una consulta de PostgREST (corta en 1000 por
// petición, así que se pagina). `query` es lo que va después de /rest/v1/.
// Este archivo solo corre en el servidor: lee con la llave de servicio cuando está configurada
// (anon ya no puede leer pedidos, clientes ni el costo de compra). { privado: true } marca las
// consultas que sin esa llave fallarían.
async function sbGetAll(query, { privado = false } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const PAGE = 1000;
  const out = [];
  const sep = query.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += PAGE) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}${sep}limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Supabase ${query.split('?')[0]} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Catálogo activo (catalogo_productos).
const CATALOGO_COLUMNS = 'id,sku,barcode,name,description,description_short,price,category_id,category_label,price_mayoreo,price_mayoreo_desde_unidades,costo_compra,low_stock_threshold,weight,width,height,depth,meta_title,meta_description,meta_keywords,link_rewrite,images,source';

async function fetchCatalogoActivo(select = CATALOGO_COLUMNS, extraFilter = '') {
  return sbGetAll(`catalogo_productos?select=${select}&active=eq.true${extraFilter}&order=id.asc`);
}

// Filas de catalogo_productos por id (activas o no), en lotes.
async function fetchCatalogoRows(ids, select = CATALOGO_COLUMNS + ',active') {
  const clean = [...new Set((ids || []).map(String).filter(s => /^\d+$/.test(s)))];
  const out = [];
  for (let i = 0; i < clean.length; i += 200) {
    out.push(...await sbGetAll(`catalogo_productos?select=${select}&id=in.(${clean.slice(i, i + 200).join(',')})`));
  }
  return out;
}

// Precio y datos reales de productos activos, para validar el carrito del
// checkout: { "83341": row }.
async function fetchPreciosActivos(ids) {
  const rows = await fetchCatalogoRows(ids, 'id,name,sku,price,active');
  const map = {};
  rows.forEach(r => { if (r.active) map[String(r.id)] = r; });
  return map;
}

module.exports = { sbGetAll, fetchCatalogoActivo, fetchCatalogoRows, fetchPreciosActivos, SUPABASE_URL, SUPABASE_ANON_KEY };
