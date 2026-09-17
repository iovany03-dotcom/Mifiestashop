'use strict';
const store = require('./migration-store');
const { lang, round } = require('./native-catalog');

async function resolveItems(items) {
  // Combine duplicates before checking quantities, so splitting a product
  // between cart lines cannot bypass stock checks.
  const quantities = new Map();
  for (const item of items) quantities.set(item.id, (quantities.get(item.id) || 0) + item.qty);
  const ids = [...quantities.keys()].join(',');
  const [products, stock] = await Promise.all([
    store.all('ps_productos_comercio', `select=*&id=in.(${ids})&order=id.asc`),
    store.all('ps_disponibilidad', `select=*&data->>id_product=in.(${ids})&order=id.asc`)
  ]);
  const byId = new Map(products.map(row => [Number(row.id), row.data]));
  return [...quantities].map(([id, qty]) => {
    const product = byId.get(id);
    if (!product || String(product.active) !== '1' || String(product.available_for_order) === '0') return null;
    const available = stock.map(row => row.data).filter(row => Number(row.id_product) === id
      && Number(row.id_product_attribute || 0) === 0 && [0,1].includes(Number(row.id_shop || 0)));
    // Do not add stock from distinct shops together; the storefront uses shop 1.
    const primary = available.find(row => Number(row.id_shop) === 1) || available.find(row => Number(row.id_shop) === 0);
    if (!primary || Number(primary.quantity) < qty) return null;
    const price = Number(product.price);
    if (!Number.isFinite(price) || price < 0) throw new Error('Precio no verificado');
    // Preserve the existing checkout's retail price policy. Specific/group
    // discounts require a verified group identity; never trust a client group ID.
    return { id, qty, name: lang(product.name, `Producto #${id}`), sku: product.reference || `PS-${id}`, price: round(price) };
  });
}

module.exports = { resolveItems };
