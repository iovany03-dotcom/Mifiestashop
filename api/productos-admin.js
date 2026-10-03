// Vercel serverless function: catálogo COMPLETO (activos e inactivos) para
// el panel de administración — a diferencia de /api/productos (tienda
// pública, POS, pedido manual), que solo trae productos activos a propósito
// (nunca se debe poder vender algo desactivado). Sesión requerida: a
// diferencia de catalogo_productos activos, qué productos están
// descontinuados/inactivos no es algo que deba verse públicamente.
//
// POST { p_admin_password, p_staff_email, p_staff_pin }
// -> { count, products: [...] } (misma forma que /api/productos, con
//    además "active" en cada producto)
const { sbGetAll } = require('../lib/prestashop.js');
const { toProduct, fetchMigrated, fetchCategoryNames } = require('../lib/productos-supabase.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const CATALOGO_COLUMNS_ADMIN = 'id,sku,barcode,name,description,description_short,price,category_id,category_label,price_mayoreo,price_mayoreo_desde_unidades,costo_compra,low_stock_threshold,weight,width,height,depth,meta_title,meta_description,meta_keywords,link_rewrite,images,source,active';

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
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const body = req.body || {};
  let session;
  try { session = await sbRpcServer('rpc_check_session', { p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null }); }
  catch (e) { res.status(401).json({ error: 'unauthorized', detail: e.message }); return; }
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return; }

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  try {
    const [rows, migrated, categoryNames] = await Promise.all([
      sbGetAll(`catalogo_productos?select=${CATALOGO_COLUMNS_ADMIN}&order=id.asc`),
      fetchMigrated(),
      fetchCategoryNames().catch(() => ({}))
    ]);
    // Datos privados por producto (código de proveedor, competencia, fecha del último cambio de costo):
    // viven en producto_privado, que solo se lee con la llave de servicio (ver
    // docs/supabase-producto-competencia.sql). Si la tabla aún no existe, el catálogo sale sin ellos.
    const privados = {};
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      try {
        for (let from = 0; ; from += 1000) {
          const pr = await fetch(`${SUPABASE_URL}/rest/v1/producto_privado?select=id,codigo_proveedor,competencia,costo_compra_actualizado_at&order=id.asc`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Range: `${from}-${from + 999}` }
          });
          if (!pr.ok) break;
          const batch = await pr.json();
          batch.forEach(x => { privados[String(x.id)] = x; });
          if (batch.length < 1000) break;
        }
      } catch (e) { /* sin datos privados */ }
    }
    const products = rows.map(r => {
      const prod = toProduct(r, migrated[String(r.id)], categoryNames, baseUrl);
      const priv = privados[String(r.id)];
      if (priv) {
        prod.codigoProveedor = priv.codigo_proveedor || '';
        prod.competencia = Array.isArray(priv.competencia) ? priv.competencia : [];
        prod.costoCompraActualizado = priv.costo_compra_actualizado_at || null;
      }
      return prod;
    });
    res.status(200).json({ count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar el catálogo completo', detail: String(err) });
  }
};
