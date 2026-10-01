// /api/productos servido 100% desde Supabase (PrestaShop desconectado, ver
// lib/prestashop.js). Devuelve exactamente la misma forma de respuesta que
// el camino en vivo de api/productos.js, armada con:
//   - catalogo_productos: precio, mayoreo, costo, medidas, SEO, fotos propias
//     (sincronizado desde PrestaShop cada 10 min por el cron)
//   - productos_migrados: nombre/descripción/categorías editados (igual que
//     en vivo, tienen prioridad)
//   - ps_categorias: nombre de la categoría por defecto
const { productoPath } = require('./url-producto.js');
const { sbGetAll, fetchCatalogoActivo } = require('./prestashop.js');

const PLACEHOLDER_IMG = 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=300';

function normalizeCategoryName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchMigrated(ids) {
  const map = {};
  const select = 'id,sku,name,description,category_label,category_ids,images';
  if (ids) {
    const clean = [...new Set(ids.map(String).filter(s => /^\d+$/.test(s)))];
    for (let i = 0; i < clean.length; i += 200) {
      (await sbGetAll(`productos_migrados?select=${select}&id=in.(${clean.slice(i, i + 200).join(',')})`)).forEach(r => { map[String(r.id)] = r; });
    }
  } else {
    (await sbGetAll(`productos_migrados?select=${select}&order=id.asc`)).forEach(r => { map[String(r.id)] = r; });
  }
  return map;
}

async function fetchCategoryNames() {
  const map = {};
  // link_rewrite de cada categoría en una propiedad aparte (no enumerable)
  // para armar la liga de producto igual que PrestaShop (lib/url-producto.js).
  const rewrites = {};
  (await sbGetAll('ps_categorias?select=id,name,link_rewrite&order=id.asc')).forEach(r => {
    map[String(r.id)] = normalizeCategoryName(r.name);
    if (r.link_rewrite) rewrites[String(r.id)] = r.link_rewrite;
  });
  Object.defineProperty(map, 'rewrites', { value: rewrites, enumerable: false });
  return map;
}

function toProduct(row, m, categoryNames, baseUrl) {
  const id = String(row.id);
  const images = (Array.isArray(row.images) && row.images.length ? row.images : null)
    || (m && Array.isArray(m.images) && m.images.length ? m.images : null);
  const linkRewrite = row.link_rewrite || '';
  const metaKeywords = String(row.meta_keywords || '').replace(/^meta\s*keywords[\s-]*/i, '').trim();
  // "desde 1 pieza" en PrestaShop no es un descuento por volumen real: es
  // el valor por default de specific_prices cuando el precio especial es
  // solo para un grupo de clientes (mayoristas/distribuidores, id 60) sin
  // ninguna cantidad mínima real. Aplicarlo aquí lo expondría a cualquier
  // cliente general (tienda pública o POS) desde la primera pieza, en vez
  // de ser exclusivo de ese grupo — por eso solo cuenta como "precio de
  // mayoreo" cuando el umbral real es mayor a 1.
  const mayoreoThreshold = row.price_mayoreo_desde_unidades;
  const priceMayoreo = (row.price_mayoreo != null && mayoreoThreshold > 1) ? Math.round(num(row.price_mayoreo) * 100) / 100 : undefined;
  const isPs = row.source === 'prestashop';
  return {
    id,
    name: m ? m.name : (row.name || 'Producto'),
    description: m && m.description ? m.description : (row.description_short || row.description || ''),
    sku: m ? m.sku : (row.sku || `PS-${id}`),
    barcode: row.barcode || undefined,
    // Ausente (undefined) para /api/productos (tienda pública/POS: siempre
    // activos, ver fetchCatalogoActivo) — presente solo cuando la fila trae
    // la columna "active" (catálogo completo del admin, ver
    // api/productos-admin.js), para poder mostrar/editar el estado real.
    active: row.active !== undefined ? !!row.active : undefined,
    price: num(row.price),
    priceMayoreo,
    priceMayoreoDesdeUnidades: priceMayoreo !== undefined ? mayoreoThreshold : undefined,
    costoCompra: num(row.costo_compra) || undefined,
    categoryId: row.category_id ? String(row.category_id) : '1',
    categoryLabel: (m && m.category_label) || categoryNames[String(row.category_id)] || row.category_label || undefined,
    categoryIds: m && Array.isArray(m.category_ids) && m.category_ids.length > 0 ? m.category_ids : undefined,
    weight: num(row.weight) || undefined,
    width: num(row.width) || undefined,
    height: num(row.height) || undefined,
    depth: num(row.depth) || undefined,
    metaTitle: row.meta_title || undefined,
    metaDescription: row.meta_description || undefined,
    metaKeywords: metaKeywords || undefined,
    lowStockThreshold: parseInt(row.low_stock_threshold, 10) || undefined,
    img: images ? images[0] : PLACEHOLDER_IMG,
    images: images || undefined,
    migrated: !!m,
    linkRewrite,
    // Liga pública del producto, con el mismo formato que PrestaShop
    // (/{categoria}/{id}-{link_rewrite}-{ean13}.html): relativa, sirve en
    // cualquier dominio del sitio. Un producto manual (creado aquí, sin
    // PrestaShop) también recibe esta URL en cuanto tiene link_rewrite
    // (ver api/guardar-producto.js) — antes se dejaba url undefined para
    // cualquier producto no sincronizado, y la tienda lo abría en el modal
    // de vista rápida en vez de su propia página.
    url: isPs
      ? (productoPath({ id, linkRewrite, ean13: row.barcode, categoryRewrite: (categoryNames.rewrites || {})[String(row.category_id)] })
        || `${baseUrl}/index.php?id_product=${id}&controller=product`)
      : (productoPath({ id, linkRewrite, ean13: row.barcode, categoryRewrite: (categoryNames.rewrites || {})[String(row.category_id)] }) || undefined)
  };
}

const SORT_COMPARATORS = {
  price_asc: (a, b) => a.price - b.price,
  price_desc: (a, b) => b.price - a.price,
  name_asc: (a, b) => a.name.localeCompare(b.name),
  name_desc: (a, b) => b.name.localeCompare(a.name)
};

async function productosDesdeSupabase(req, res, { limit, offset, category, sortKey, idsMode, requestedIds, baseUrl }) {
  try {
    if (idsMode) {
      if (!requestedIds.length) {
        res.status(200).json({ count: 0, products: [] });
        return;
      }
      const [rows, migrated] = await Promise.all([
        sbGetAll(`catalogo_productos?select=id,sku,price&active=eq.true&id=in.(${requestedIds.join(',')})`),
        fetchMigrated(requestedIds)
      ]);
      const slim = rows.map(r => {
        const m = migrated[String(r.id)];
        return { id: Number(r.id), price: num(r.price), sku: m ? m.sku : (r.sku || `PS-${r.id}`) };
      });
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
      res.status(200).json({ count: slim.length, products: slim });
      return;
    }

    const [rows, migrated, categoryNames] = await Promise.all([
      fetchCatalogoActivo(),
      fetchMigrated(),
      fetchCategoryNames().catch(() => ({}))
    ]);

    let selected = rows;
    if (category) {
      // Mismo criterio que en vivo: categoría por defecto UNIDA con el
      // listado completo de categorías de los productos migrados.
      const cat = String(category);
      selected = rows.filter(r => {
        if (String(r.category_id) === cat) return true;
        const m = migrated[String(r.id)];
        return !!(m && Array.isArray(m.category_ids) && m.category_ids.map(String).includes(cat));
      });
    }

    const products = selected.map(r => toProduct(r, migrated[String(r.id)], categoryNames, baseUrl));
    if (SORT_COMPARATORS[sortKey]) products.sort(SORT_COMPARATORS[sortKey]);

    // Catálogo público (solo activos, mismos datos para todos): sin esto
    // cada visita/cambio de categoría volvía a leer ~1,000 productos de
    // Supabase. El precio que se cobra se revalida aparte en
    // api/crear-pedido.js, así que un minuto de caché no afecta el cobro.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      count: Math.max(0, Math.min(limit, products.length - offset)),
      total: products.length,
      products: products.slice(offset, offset + limit),
      source: 'supabase'
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar el catálogo en Supabase', detail: String(err) });
  }
}

module.exports = { productosDesdeSupabase, fetchMigrated, fetchCategoryNames, toProduct };
