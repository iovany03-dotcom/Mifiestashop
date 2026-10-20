// API pública /api/v1/products — lista de productos, autenticada con API key.
// Scope requerido: products:read
//
// Sale de catalogo_productos (igual que el resto del sitio); nombre,
// descripción e imágenes usan la versión migrada cuando existe (ver
// productos_migrados).
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');
const { fetchCatalogoActivo } = require('../../../lib/catalogo-supabase.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SITE_URL = 'https://www.mifiestashop.com';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function fetchMigratedById(ids) {
  if (!ids.length) return {};
  const map = {};
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/productos_migrados?id=in.(${chunk.join(',')})&select=id,sku,name,description,category_label,images`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!r.ok) continue;
    const rows = await r.json();
    (Array.isArray(rows) ? rows : []).forEach(row => { map[String(row.id)] = row; });
  }
  return map;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return sendApiError(res, 405, 'Método no permitido. Usa GET.', 'method_not_allowed');

  const auth = await authenticateApiRequest(req, 'products:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const category = req.query.category;
  const search = (req.query.search || '').trim().toLowerCase();

  try {
    const catFilter = category && /^\d+$/.test(String(category)) ? `&category_id=eq.${category}` : '';
    const rows = await fetchCatalogoActivo('id,sku,name,description,description_short,price,category_id,link_rewrite,images,source', catFilter);
    const migrated = await fetchMigratedById(rows.map(r => r.id));
    let products = rows.map(r => {
      const m = migrated[String(r.id)];
      const images = Array.isArray(r.images) && r.images.length ? r.images : (m && Array.isArray(m.images) && m.images.length ? m.images : null);
      return {
        id: Number(r.id),
        sku: m ? m.sku : (r.sku || undefined),
        name: m ? m.name : (r.name || 'Producto'),
        description: m && m.description ? m.description : (r.description_short || undefined),
        price: Number(r.price) || 0,
        category_id: Number(r.category_id) || undefined,
        category_label: m ? m.category_label : undefined,
        image: images ? images[0] : null,
        url: r.source === 'prestashop' && r.link_rewrite ? `${SITE_URL}/${r.id}-${r.link_rewrite}.html` : undefined
      };
    });
    if (search) products = products.filter(p => (p.name || '').toLowerCase().includes(search) || (p.sku || '').toLowerCase().includes(search));
    return res.status(200).json({ data: products.slice(offset, offset + limit), meta: { total: products.length, limit, offset } });
  } catch (err) {
    return sendApiError(res, 500, 'Error al consultar productos: ' + err.message, 'internal_error');
  }
};
