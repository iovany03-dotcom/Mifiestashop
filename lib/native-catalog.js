'use strict';
const store = require('./migration-store');

function lang(value, fallback = '') {
  if (typeof value === 'string') return value || fallback;
  if (Array.isArray(value)) return value.map(entry => lang(entry?.value ?? entry)).find(Boolean) || fallback;
  if (value && typeof value === 'object') return lang(value.value ?? Object.values(value), fallback);
  return fallback;
}
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

function wholesale(base, rules, id, now = new Date()) {
  const time = now.getTime();
  const validDate = (value, after) => {
    if (!value || String(value).startsWith('0000-')) return true;
    const date = Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? '' : '-06:00'));
    return Number.isFinite(date) && (after ? time >= date : time <= date);
  };
  const applicable = rules.filter(rule => String(rule.id_product) === String(id)
    && String(rule.id_group) === '60'
    && ['id_customer', 'id_cart', 'id_product_attribute', 'id_currency', 'id_country'].every(k => Number(rule[k] || 0) === 0)
    && [0, 50].includes(Number(rule.id_shop || 0))
    && validDate(rule.from, true) && validDate(rule.to, false))
    .sort((a, b) => Number(a.from_quantity) - Number(b.from_quantity) || Number(a.id) - Number(b.id));
  if (!applicable.length) return null;
  const rule = applicable[0];
  let price = Number(rule.price) >= 0 ? Number(rule.price) : base;
  const reduction = Number(rule.reduction || 0);
  // Tax-inclusive absolute reductions need tax context; don't advertise an
  // unverified net price. The full original rule is still preserved privately.
  if (rule.reduction_type === 'amount' && Number(rule.reduction_tax) === 1 && reduction) return null;
  price = rule.reduction_type === 'percentage' ? price * (1 - reduction) : price - reduction;
  if (!Number.isFinite(price) || price < 0) throw new Error('Regla de precio inválida');
  return { price: round(price), fromQty: Number(rule.from_quantity) || 1 };
}

async function catalog() {
  const [snapshots, migrated, prices] = await Promise.all([
    store.all('ps_productos_comercio', 'select=*&data->>active=eq.1&order=id.asc'), store.all('productos_migrados'),
    store.all('ps_precios_especificos', 'select=*&data->>id_group=eq.60&order=id.asc')
  ]);
  if (!snapshots.length) throw new Error('El catálogo comercial todavía no está importado');
  const descriptions = new Map(migrated.map(row => [String(row.id), row]));
  const rules = prices.map(row => row.data);
  return snapshots.filter(row => String(row.data.active) === '1').map(({ data: p }) => {
    const local = descriptions.get(String(p.id));
    const images = local?.images || [];
    const price = Number(p.price);
    if (!Number.isFinite(price) || price < 0) throw new Error(`Precio inválido: ${p.id}`);
    const offer = wholesale(price, rules, p.id);
    const slug = lang(p.link_rewrite);
    return {
      id: p.id, name: local?.name || lang(p.name), sku: local?.sku || p.reference || `PS-${p.id}`,
      description: local?.description || lang(p.description_short, lang(p.description)).replace(/<[^>]*>/g, ''),
      price, priceMayoreo: offer?.price, priceMayoreoDesdeUnidades: offer?.fromQty,
      categoryId: String(p.id_category_default), categoryLabel: local?.category_label,
      categoryIds: local?.category_ids || [], images, img: images[0] || '/img/cms/logo.webp',
      linkRewrite: slug, url: slug ? `/${p.id}-${slug}.html` : `/${p.id}-producto.html`,
      barcode: p.ean13 || undefined, weight: Number(p.weight) || undefined,
      width: Number(p.width) || undefined, height: Number(p.height) || undefined, depth: Number(p.depth) || undefined,
      metaTitle: lang(p.meta_title), metaDescription: lang(p.meta_description),
      metaKeywords: lang(p.meta_keywords).replace(/^meta\s*keywords[\s-]*/i, '').trim(),
      lowStockThreshold: Number(p.low_stock_threshold) || undefined, migrated: Boolean(local)
    };
  });
}

async function products(req, res) {
  try {
    let rows = await catalog();
    if (req.query.category) rows = rows.filter(p => String(p.categoryId) === String(req.query.category));
    const sorts = {
      price_asc: (a,b) => a.price-b.price, price_desc: (a,b) => b.price-a.price,
      name_asc: (a,b) => a.name.localeCompare(b.name,'es'), name_desc: (a,b) => b.name.localeCompare(a.name,'es')
    };
    rows.sort(sorts[req.query.sort] || ((a,b) => Number(a.id)-Number(b.id)));
    const offset = Math.max(0, Number.parseInt(req.query.offset,10) || 0);
    const limit = Math.min(5000, Math.max(1, Number.parseInt(req.query.limit,10) || 500));
    const products = rows.slice(offset, offset+limit);
    res.status(200).json({ products, count: products.length, total: rows.length, source: 'supabase' });
  } catch (error) { res.status(503).json({ error: error.message }); }
}

module.exports = { catalog, products, lang, wholesale, round };
