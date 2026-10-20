// API pública /api/v1/products/:id — detalle y edición de un producto.
// GET  scope products:read
// PATCH scope products:write — SOLO campos descriptivos (name, description,
// images, category_label), escritos en productos_migrados. Precio y stock
// nunca se aceptan aquí: se administran solo desde el panel (catálogo e
// inventario) — exponerlos como editables por API daría una falsa sensación
// de control sobre el inventario real. Crear un producto que no existe en
// el catálogo tampoco está soportado (ver la página de documentación).
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');
const { fetchCatalogoImages } = require('../../../lib/catalogo-productos.js');
const { fetchCatalogoRows } = require('../../../lib/catalogo-supabase.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

const SITE_URL = 'https://www.mifiestashop.com';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const id = parseInt(req.query.id, 10);
  if (!id) return sendApiError(res, 400, 'id inválido.', 'invalid_id');

  // El producto activo, de catalogo_productos.
  async function loadProduct() {
    const row = (await fetchCatalogoRows([id], 'id,sku,name,description,price,category_id,link_rewrite,weight,active,source'))[0];
    if (!row || !row.active) return null;
    return row;
  }

  if (req.method === 'GET') {
    const auth = await authenticateApiRequest(req, 'products:read');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);

    try {
      const p = await loadProduct();
      if (!p) return sendApiError(res, 404, 'Producto no encontrado.', 'not_found');

      const mr = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?id=eq.${id}&select=sku,name,description,category_label,images`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
      });
      const mRows = mr.ok ? await mr.json() : [];
      const m = Array.isArray(mRows) && mRows[0];
      const own = (await fetchCatalogoImages([id]))[String(id)];

      const linkRewrite = p.source === 'prestashop' ? (p.link_rewrite || '') : '';
      const image = own ? own[0] : (m && Array.isArray(m.images) && m.images[0] ? m.images[0] : null);

      res.status(200).json({
        data: {
          id: Number(p.id),
          sku: m ? m.sku : (p.sku || undefined),
          name: m ? m.name : (p.name || 'Producto'),
          description: m && m.description ? m.description : String(p.description || '').replace(/<[^>]*>/g, '').trim() || undefined,
          price: Number(p.price) || 0,
          weight: Number(p.weight) || undefined,
          category_id: Number(p.category_id) || undefined,
          category_label: m ? m.category_label : undefined,
          image,
          images: m && Array.isArray(m.images) && m.images.length ? m.images : undefined,
          url: linkRewrite ? `${SITE_URL}/${p.id}-${linkRewrite}.html` : undefined
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
      return sendApiError(res, 422, `No se puede editar ${disallowedTouched.join(', ')} por API: se administra desde el panel.`, 'read_only_field');
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
      // Confirma que el producto existe y está activo antes de guardar la
      // sobreescritura — nunca se acepta un id inventado.
      const product = await loadProduct();
      if (!product) return sendApiError(res, 404, 'Producto no encontrado.', 'not_found');

      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');

      const existingR = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?id=eq.${id}&select=id,sku,name,description,category_label,images`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      });
      const existingRows = existingR.ok ? await existingR.json() : [];
      const existing = Array.isArray(existingRows) && existingRows[0];

      const row = {
        id,
        sku: existing?.sku || product.sku || `PS-${id}`,
        name: update.name !== undefined ? update.name : (existing?.name || product.name || 'Producto'),
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
          price: Number(product.price) || 0
        }
      });
    } catch (err) {
      sendApiError(res, 500, 'Error al actualizar el producto: ' + err.message, 'internal_error');
    }
    return;
  }

  sendApiError(res, 405, 'Método no permitido. Usa GET o PATCH.', 'method_not_allowed');
};
