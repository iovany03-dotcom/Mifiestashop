// Vercel serverless function: guarda (crea o edita) un producto en
// catalogo_productos — el destino real de lectura del catálogo (ver
// lib/sync-prestashop.js, dominio "productos", y la migración de
// api/productos.js para leer de aquí en vez de PrestaShop en vivo).
//
// Antes, el botón "Guardar" del admin (saveProductChanges() en index.html)
// solo escribía a costos_productos_publico vía rpc_catalog_update_producto
// — una tabla que solo se usa como respaldo del lado del cliente cuando
// PrestaShop no responde, nunca leída por api/productos.js ni por el resto
// del sitio. En la práctica, ningún cambio guardado ahí se reflejaba nunca
// en el catálogo real mientras PrestaShop siguiera respondiendo — lo cual
// deja de ser cierto en cuanto se apague PrestaShop para siempre.
//
// POST body: { p_admin_password, p_staff_email, p_staff_pin, producto: {...} }
// -> { ok: true, id }

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function sbRpcServer(fnName, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) throw new Error(`rpc ${fnName} -> HTTP ${r.status}`);
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const body = req.body || {};
  const p_admin_password = body.p_admin_password ?? null;
  const p_staff_email = body.p_staff_email ?? null;
  const p_staff_pin = body.p_staff_pin ?? null;
  const producto = body.producto || {};

  let session;
  try { session = await sbRpcServer('rpc_check_session', { p_admin_password, p_staff_email, p_staff_pin }); }
  catch (e) { res.status(401).json({ ok: false, error: 'unauthorized', detail: e.message }); return; }
  if (!session) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    res.status(500).json({ ok: false, error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' });
    return;
  }

  const name = String(producto.name || '').trim();
  const sku = String(producto.sku || '').trim();
  if (!name || !sku) {
    res.status(400).json({ ok: false, error: 'Falta nombre o SKU' });
    return;
  }

  // Productos creados aquí (sin PrestaShop) usan un id fuera del rango real
  // de PrestaShop para no chocar nunca con un id importado del catálogo
  // original.
  const isNew = !producto.id;
  const id = isNew ? 9000000000000 + Date.now() : Number(producto.id);

  const row = {
    id,
    sku,
    barcode: producto.barcode ? String(producto.barcode).trim() : null,
    name,
    description: producto.description ? String(producto.description).trim() : null,
    description_short: null,
    price: Number.isFinite(Number(producto.price)) ? Number(producto.price) : 0,
    wholesale_price: Number(producto.priceMayoreo) || null,
    category_id: null,
    active: producto.active !== false,
    low_stock_threshold: Number(producto.lowStockThreshold) || null,
    meta_title: null,
    meta_description: null,
    meta_keywords: null,
    link_rewrite: null,
    legacy_image_url: producto.img ? String(producto.img).trim() : null,
    // categoría y precios especiales adicionales se guardan como texto en
    // description hasta que el admin de catálogo tenga sus propios campos;
    // category_label se preserva aparte para no perder el nombre visible.
    category_label: producto.categoryLabel ? String(producto.categoryLabel).trim() : null,
    price_mayoreo_desde_unidades: Number(producto.priceMayoreoDesdeUnidades) || null,
    price_volumen: Number(producto.priceVolumen) || null,
    price_distribuidor: Number(producto.priceDistribuidor) || null,
    costo_compra: Number(producto.costoCompra) || null,
    source: 'manual',
    updated_at: new Date().toISOString()
  };

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/catalogo_productos?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify([row])
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      res.status(502).json({ ok: false, error: `Supabase HTTP ${r.status}`, detail: text.slice(0, 400) });
      return;
    }
    res.status(200).json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
