// Vercel serverless function: sirve el catálogo público desde Supabase
// (catalogo_productos + productos_migrados) — ya NO en vivo de PrestaShop.
//
// PrestaShop se va a dar de baja de forma permanente. catalogo_productos
// se llena por un sync horario (dominio "productos", ver
// lib/sync-prestashop.js) mientras PrestaShop siga arriba; una vez apagado,
// catalogo_productos se queda con el último dato bueno y el catálogo real
// pasa a editarse desde aquí en adelante (ver api/guardar-producto.js, el
// botón "Guardar" del admin).
//
// Para los productos que ya tienen un registro en productos_migrados —
// nombre, descripción, SKU, categoría e imágenes reales, re-hospedadas en
// Supabase Storage desde antes — se usan esos datos en vez de los del sync.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function sbSelectAll(table, query) {
  // PostgREST limita a 1000 filas por default — hay que paginar con el
  // header Range si no se pierden silenciosamente las últimas (ya pasó una
  // vez con productos_migrados).
  const PAGE_SIZE = 1000;
  const out = [];
  let from = 0;
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${from}-${from + PAGE_SIZE - 1}`
      }
    });
    if (!r.ok) break;
    const rows = await r.json();
    const batch = Array.isArray(rows) ? rows : [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function fetchMigratedProducts() {
  try {
    const rows = await sbSelectAll('productos_migrados', 'select=id,sku,name,description,category_label,category_ids,images');
    const map = {};
    rows.forEach(row => { map[String(row.id)] = row; });
    return map;
  } catch (e) {
    return {};
  }
}

// Algunas categorías vienen capturadas en PrestaShop TODO EN MAYÚSCULAS
// (p.ej. "ARTÍCULOS DE XV AÑOS"), distinto del resto ("Globos", "Despedida
// de soltera"...) — se re-castean aquí, en lectura, para que se vean
// consistentes sin tener que escribir de vuelta a PrestaShop ni pelear con
// que el sync horario (ps_categorias) las vuelva a sobreescribir.
function normalizeCategoryName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

async function fetchCategoryNames() {
  try {
    const rows = await sbSelectAll('ps_categorias', 'select=id,name');
    const map = {};
    rows.forEach(row => { map[String(row.id)] = normalizeCategoryName(row.name); });
    return map;
  } catch (e) {
    return {};
  }
}

async function fetchCatalog() {
  const fields = 'id,sku,barcode,name,description,description_short,price,price_mayoreo,price_mayoreo_desde_unidades,costo_compra,category_id,category_label,active,low_stock_threshold,weight,width,height,depth,meta_title,meta_description,meta_keywords,link_rewrite,legacy_image_url,images';
  return sbSelectAll('catalogo_productos', `select=${fields}&active=eq.true&order=id.asc`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const limit = parseInt(req.query.limit, 10) || 500;
  const offset = parseInt(req.query.offset, 10) || 0;
  const category = req.query.category;
  // Modo rápido: para una vista previa pequeña (p.ej. "Productos Destacados"
  // del home) que no necesita nombre/imagen migrados — evita esa consulta
  // extra, que de otra forma pesa igual sin importar cuántos productos se
  // pidan con `limit`.
  const fast = req.query.fast === '1';
  const SORT_COMPARATORS = {
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
    name_asc: (a, b) => a.name.localeCompare(b.name, 'es'),
    name_desc: (a, b) => b.name.localeCompare(a.name, 'es')
  };
  const sortKey = req.query.sort;

  try {
    const [rawProducts, migrated, categoryNames] = await Promise.all([
      fetchCatalog(),
      fast ? Promise.resolve({}) : fetchMigratedProducts(),
      fetchCategoryNames()
    ]);

    let products = rawProducts.map(p => {
      const id = p.id;
      const m = migrated[String(id)];
      const images = m && Array.isArray(m.images) && m.images.length > 0
        ? m.images
        : (Array.isArray(p.images) && p.images.length > 0 ? p.images : null);
      // Orden de fotos: migradas > re-hospedadas por el sync > la que
      // todavía sirve PrestaShop en vivo (deja de funcionar en cuanto se
      // apague) > genérico de relleno.
      const imageUrl = images ? images[0] : (p.legacy_image_url || 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=300');
      const linkRewrite = p.link_rewrite || '';
      const publicUrl = linkRewrite ? `/${id}-${linkRewrite}.html` : `/producto/${p.sku || id}`;

      return {
        id,
        name: m ? m.name : p.name,
        description: m && m.description ? m.description : (p.description_short || p.description || ''),
        sku: m ? m.sku : (p.sku || `PS-${id}`),
        barcode: p.barcode || undefined,
        price: Number(p.price) || 0,
        priceMayoreo: p.price_mayoreo != null ? Number(p.price_mayoreo) : undefined,
        priceMayoreoDesdeUnidades: p.price_mayoreo_desde_unidades != null ? Number(p.price_mayoreo_desde_unidades) : undefined,
        costoCompra: p.costo_compra != null ? Number(p.costo_compra) : undefined,
        categoryId: p.category_id != null ? String(p.category_id) : '1',
        categoryLabel: (m && m.category_label) || p.category_label || categoryNames[String(p.category_id)] || undefined,
        categoryIds: m && Array.isArray(m.category_ids) && m.category_ids.length > 0 ? m.category_ids : undefined,
        weight: p.weight != null ? Number(p.weight) : undefined,
        width: p.width != null ? Number(p.width) : undefined,
        height: p.height != null ? Number(p.height) : undefined,
        depth: p.depth != null ? Number(p.depth) : undefined,
        metaTitle: p.meta_title || undefined,
        metaDescription: p.meta_description || undefined,
        metaKeywords: p.meta_keywords || undefined,
        lowStockThreshold: p.low_stock_threshold || undefined,
        img: imageUrl,
        images: images || undefined,
        migrated: !!m,
        linkRewrite,
        url: publicUrl
      };
    });

    if (category) {
      const migratedCatIds = new Set(
        Object.values(migrated)
          .filter(m => Array.isArray(m.category_ids) && m.category_ids.map(String).includes(String(category)))
          .map(m => String(m.id))
      );
      products = products.filter(p => String(p.categoryId) === String(category) || migratedCatIds.has(String(p.id)));
    }

    if (SORT_COMPARATORS[sortKey]) products.sort(SORT_COMPARATORS[sortKey]);

    const total = products.length;
    const pageProducts = products.slice(offset, offset + limit);

    res.status(200).json({
      count: pageProducts.length,
      total,
      products: pageProducts,
      source: 'supabase'
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar el catálogo en Supabase', detail: String(err) });
  }
};
