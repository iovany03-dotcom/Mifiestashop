// API pública /api/v1/products/:id — detalle y edición de un producto.
// GET  scope products:read
// PATCH scope products:write — SOLO campos descriptivos (name, description,
// images, category_label), escritos en productos_migrados. Precio y stock
// nunca se aceptan aquí: siguen viniendo únicamente de PrestaShop, la misma
// regla que ya sigue el resto del sitio (ver api/productos.js) — exponerlos
// como editables por API daría una falsa sensación de control sobre el
// inventario real. Crear un producto que no existe todavía en PrestaShop
// tampoco está soportado (ver la página de documentación): no aparecería en
// ningún otro lado del sitio, así que no tendría caso "crearlo" solo aquí.
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const id = parseInt(req.query.id, 10);
  if (!id) return sendApiError(res, 400, 'id inválido.', 'invalid_id');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  if (!apiKey) return sendApiError(res, 500, 'PS_API_KEY no configurado en Vercel.', 'not_configured');
  const authHeaders = { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` };

  if (req.method === 'GET') {
    const auth = await authenticateApiRequest(req, 'products:read');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);

    try {
      const fields = '[id,name,reference,price,id_default_image,id_category_default,active,description_short,description,link_rewrite,weight]';
      const r = await fetch(`${baseUrl}/api/products/${id}?display=${encodeURIComponent(fields)}&output_format=JSON`, { headers: authHeaders });
      if (r.status === 404) return sendApiError(res, 404, 'Producto no encontrado.', 'not_found');
      if (!r.ok) return sendApiError(res, 502, `PrestaShop respondió ${r.status}.`, 'upstream_error');
      const data = await r.json();
      const p = data.product;
      if (!p || p.active !== '1') return sendApiError(res, 404, 'Producto no encontrado.', 'not_found');

      const mr = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?id=eq.${id}&select=sku,name,description,category_label,images`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
      });
      const mRows = mr.ok ? await mr.json() : [];
      const m = Array.isArray(mRows) && mRows[0];

      const linkRewrite = firstLangValue(p.link_rewrite, '');
      const imgId = p.id_default_image;
      const image = m && Array.isArray(m.images) && m.images[0]
        ? m.images[0]
        : (imgId && imgId !== '0' ? `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}` : null);

      res.status(200).json({
        data: {
          id: Number(p.id),
          sku: m ? m.sku : (p.reference || undefined),
          name: m ? m.name : firstLangValue(p.name, 'Producto'),
          description: m && m.description ? m.description : firstLangValue(p.description, '').replace(/<[^>]*>/g, '').trim() || undefined,
          price: parseFloat(p.price || 0),
          weight: parseFloat(p.weight || 0) || undefined,
          category_id: Number(p.id_category_default) || undefined,
          category_label: m ? m.category_label : undefined,
          image,
          images: m && Array.isArray(m.images) && m.images.length ? m.images : undefined,
          url: linkRewrite ? `${baseUrl}/${p.id}-${linkRewrite}.html` : undefined
        }
      });
    } catch (err) {
      sendApiError(res, 500, 'Error al consultar el producto: ' + err.message, 'internal_error');
    }
    return;
  }

  if (req.method === 'PATCH') {
    const auth = await authenticateApiRequest(req, 'products:write');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const allowed = ['name', 'description', 'images', 'category_label'];
    const disallowedTouched = Object.keys(body).filter(k => ['price', 'stock', 'quantity'].includes(k));
    if (disallowedTouched.length) {
      return sendApiError(res, 422, `No se puede editar ${disallowedTouched.join(', ')} por API: siempre viene en vivo de PrestaShop.`, 'read_only_field');
    }
    const update = {};
    allowed.forEach(k => { if (body[k] !== undefined) update[k] = body[k]; });
    if (Object.keys(update).length === 0) {
      return sendApiError(res, 422, `Nada que actualizar. Campos permitidos: ${allowed.join(', ')}.`, 'no_fields');
    }
    if (update.images !== undefined && !Array.isArray(update.images)) {
      return sendApiError(res, 422, 'images debe ser un arreglo de URLs.', 'invalid_field');
    }

    try {
      // Confirma que el producto existe y está activo en PrestaShop antes de
      // guardar la sobreescritura — nunca se acepta un id inventado.
      const checkFields = '[id,name,reference,active]';
      const cr = await fetch(`${baseUrl}/api/products/${id}?display=${encodeURIComponent(checkFields)}&output_format=JSON`, { headers: authHeaders });
      if (cr.status === 404) return sendApiError(res, 404, 'Producto no encontrado.', 'not_found');
      if (!cr.ok) return sendApiError(res, 502, `PrestaShop respondió ${cr.status}.`, 'upstream_error');
      const cdata = await cr.json();
      const psProduct = cdata.product;
      if (!psProduct || psProduct.active !== '1') return sendApiError(res, 404, 'Producto no encontrado.', 'not_found');

      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');

      const existingR = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?id=eq.${id}&select=id,sku,name,description,category_label,images`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      });
      const existingRows = existingR.ok ? await existingR.json() : [];
      const existing = Array.isArray(existingRows) && existingRows[0];

      const row = {
        id,
        sku: existing?.sku || psProduct.reference || `PS-${id}`,
        name: update.name !== undefined ? update.name : (existing?.name || firstLangValue(psProduct.name, 'Producto')),
        description: update.description !== undefined ? update.description : (existing?.description || null),
        category_label: update.category_label !== undefined ? update.category_label : (existing?.category_label || null),
        images: update.images !== undefined ? update.images : (existing?.images || null)
      };

      const upsertR = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?on_conflict=id`, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(row)
      });
      if (!upsertR.ok) {
        const text = await upsertR.text().catch(() => '');
        return sendApiError(res, 502, 'No se pudo guardar el cambio: ' + text.slice(0, 300), 'upstream_error');
      }
      const saved = await upsertR.json();
      const s = Array.isArray(saved) ? saved[0] : saved;
      res.status(200).json({
        data: {
          id: Number(s.id), sku: s.sku, name: s.name, description: s.description || undefined,
          category_label: s.category_label || undefined, images: s.images || undefined,
          price: parseFloat(psProduct.price || 0)
        }
      });
    } catch (err) {
      sendApiError(res, 500, 'Error al actualizar el producto: ' + err.message, 'internal_error');
    }
    return;
  }

  sendApiError(res, 405, 'Método no permitido. Usa GET o PATCH.', 'method_not_allowed');
};
