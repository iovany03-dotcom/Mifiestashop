// API pública /api/v1/products — lista de productos, autenticada con API key.
// Scope requerido: products:read
//
// Precio y stock siempre vienen en vivo de PrestaShop (igual que el resto
// del sitio); nombre/descripción/imágenes usan la versión migrada cuando
// existe (ver productos_migrados) — así un socio nunca ve un precio
// desactualizado, aunque el texto pueda venir de nuestra propia edición.
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

function firstLangValue(field, fallback) {
  let val = field;
  if (Array.isArray(field)) { val = field[0]?.value; if (val === undefined) val = field[0]; }
  else if (field && typeof field === 'object') { val = field.value !== undefined ? field.value : Object.values(field)[0]; }
  if (typeof val !== 'string' || val === '') return fallback;
  return val;
}

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

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  if (!apiKey) return sendApiError(res, 500, 'PS_API_KEY no configurado en Vercel.', 'not_configured');

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const category = req.query.category;
  const search = (req.query.search || '').trim().toLowerCase();

  try {
    const fields = '[id,name,reference,price,id_default_image,id_category_default,active,description_short,link_rewrite]';
    let filters = 'filter[active]=1';
    if (category) filters += `&filter[id_category_default]=${encodeURIComponent('[' + category + ']')}`;
    const authHeaders = { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` };

    // Se pide más de lo pedido cuando hay texto de búsqueda: PrestaShop no
    // soporta buscar por nombre vía este filtro, así que se filtra aquí
    // sobre una ventana razonable en vez de sobre todo el catálogo.
    const fetchLimit = search ? 1000 : limit;
    const fetchOffset = search ? 0 : offset;
    const url = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&${filters}&limit=${fetchOffset},${fetchLimit}&output_format=JSON`;
    const r = await fetch(url, { headers: authHeaders });
    if (!r.ok) return sendApiError(res, 502, `PrestaShop respondió ${r.status}.`, 'upstream_error');
    const data = await r.json();
    let rawProducts = Array.isArray(data.products) ? data.products : [];

    const migrated = await fetchMigratedById(rawProducts.map(p => p.id));

    let products = rawProducts.map(p => {
      const m = migrated[String(p.id)];
      const name = m ? m.name : firstLangValue(p.name, 'Producto');
      const linkRewrite = firstLangValue(p.link_rewrite, '');
      const imgId = p.id_default_image;
      const image = m && Array.isArray(m.images) && m.images[0]
        ? m.images[0]
        : (imgId && imgId !== '0' ? `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}` : null);
      return {
        id: Number(p.id),
        sku: m ? m.sku : (p.reference || undefined),
        name,
        description: m && m.description ? m.description : firstLangValue(p.description_short, '').replace(/<[^>]*>/g, '').trim() || undefined,
        price: parseFloat(p.price || 0),
        category_id: Number(p.id_category_default) || undefined,
        category_label: m ? m.category_label : undefined,
        image,
        url: linkRewrite ? `${baseUrl}/${p.id}-${linkRewrite}.html` : undefined
      };
    });

    if (search) {
      products = products.filter(p => (p.name || '').toLowerCase().includes(search) || (p.sku || '').toLowerCase().includes(search));
      const total = products.length;
      products = products.slice(offset, offset + limit);
      return res.status(200).json({ data: products, meta: { total, limit, offset } });
    }

    // Conteo real del total (id-only, liviano) para poder paginar sin
    // adivinar cuántas páginas quedan — PrestaShop no lo da directo.
    let total = rawProducts.length;
    try {
      const countUrl = `${baseUrl}/api/products?display=${encodeURIComponent('[id]')}&${filters}&limit=0,5000&output_format=JSON`;
      const cr = await fetch(countUrl, { headers: authHeaders });
      const cdata = cr.ok ? await cr.json() : null;
      if (cdata && Array.isArray(cdata.products)) total = cdata.products.length;
    } catch (e) { /* se queda con el conteo de esta página */ }

    res.status(200).json({ data: products, meta: { total, limit, offset } });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar productos: ' + err.message, 'internal_error');
  }
};
