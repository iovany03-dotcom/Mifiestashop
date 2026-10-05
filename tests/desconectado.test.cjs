// Modo desconectado (default, sin PRESTASHOP_CONECTADO): cada endpoint debe
// responder desde Supabase y NUNCA consultar PrestaShop — el mock de fetch
// truena si alguien pide algo a https://ps.test.
const test = require('node:test'), assert = require('node:assert/strict');

delete process.env.PRESTASHOP_CONECTADO;
process.env.PS_API_KEY = 'llave-secreta';
process.env.PS_BASE_URL = 'https://ps.test';

function response() {
  return {
    code: 0, data: null, sent: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; },
    send(d) { this.sent = d; return this; }
  };
}

// tables: { 'catalogo_productos': rows | (url => rows) }. Solo la primera
// página (offset=0) trae filas, como PostgREST con menos de 1000.
function mockSupabase(tables, seen = []) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('https://ps.test')) throw new Error('consultó PrestaShop: ' + u);
    const m = u.match(/\/rest\/v1\/([a-z_]+)/);
    const table = m && m[1];
    if (!table || !(table in tables)) return { ok: true, json: async () => [], headers: { get: () => null } };
    const offset = Number((u.match(/[?&]offset=(\d+)/) || [])[1] || 0);
    const src = tables[table];
    const rows = offset > 0 ? [] : (typeof src === 'function' ? src(u, opts) : src);
    return { ok: true, json: async () => rows, text: async () => '', headers: { get: k => (k === 'content-range' ? `0-0/${tables.__count || 0}` : null) } };
  };
  return seen;
}

const CATALOGO = [
  { id: 101, sku: 'GLB-1', name: 'Globo rojo', description: 'Largo', description_short: 'Corto', price: 10, category_id: 269, price_mayoreo: 8.5, price_mayoreo_desde_unidades: 6, costo_compra: 4, link_rewrite: 'globo-rojo', images: ['https://sb/101.jpg'], source: 'prestashop', meta_keywords: 'Meta keywords- fiesta' },
  { id: 102, sku: 'VEL-1', name: 'Vela', description: null, description_short: null, price: 25, category_id: 270, price_mayoreo: null, link_rewrite: 'vela', images: null, source: 'prestashop' },
  { id: 103, sku: 'ANT-1', name: 'Antifaz', price: 5, category_id: 270, link_rewrite: 'antifaz', images: null, source: 'prestashop' },
  { id: 104, sku: 'BND-1', name: 'Banda', price: 30, category_id: 270, price_mayoreo: 28, price_mayoreo_desde_unidades: 1, link_rewrite: 'banda', images: null, source: 'prestashop' }
];
const MIGRADOS = [
  { id: 102, sku: 'VEL-MIG', name: 'Vela migrada', description: 'Desc migrada', category_label: 'Velas', category_ids: [270, 269], images: ['https://sb/102-mig.jpg'] }
];

test('productos: catálogo completo desde Supabase con la misma forma que en vivo', async () => {
  mockSupabase({ catalogo_productos: CATALOGO, productos_migrados: MIGRADOS, ps_categorias: [{ id: 269, name: 'GLOBOS', link_rewrite: 'globos' }, { id: 270, name: 'Velas', link_rewrite: 'velas' }] });
  const res = response();
  await require('../api/productos.js')({ query: { limit: '5000' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.total, 4);
  const [globo, vela, antifaz, banda] = res.data.products;
  assert.equal(globo.id, '101'); assert.equal(globo.img, 'https://sb/101.jpg'); assert.equal(globo.priceMayoreo, 8.5); assert.equal(globo.priceMayoreoDesdeUnidades, 6);
  assert.equal(globo.categoryLabel, 'Globos'); assert.equal(globo.metaKeywords, 'fiesta'); assert.equal(globo.description, 'Corto'); assert.equal(globo.url, '/globos/101-globo-rojo.html'); // mismo formato que PrestaShop: /{categoria}/{id}-{rewrite}[-{ean13}].html
  assert.equal(vela.name, 'Vela migrada'); assert.equal(vela.sku, 'VEL-MIG'); assert.equal(vela.img, 'https://sb/102-mig.jpg'); assert.equal(vela.migrated, true);
  assert.match(antifaz.img, /unsplash/);
  // "desde 1 pieza" en PrestaShop no es un descuento real por volumen (es
  // el default cuando el precio especial es solo para clientes de
  // mayoreo/distribuidores) — no debe salir como precio de mayoreo público.
  assert.equal(banda.priceMayoreo, undefined); assert.equal(banda.priceMayoreoDesdeUnidades, undefined); assert.equal(banda.price, 30);
  assert.ok(!JSON.stringify(res.data).includes('llave-secreta'));
});

test('productos: filtro por categoría incluye las categorías de los migrados, con orden y página', async () => {
  mockSupabase({ catalogo_productos: CATALOGO, productos_migrados: MIGRADOS, ps_categorias: [] });
  const res = response();
  await require('../api/productos.js')({ query: { category: '269', sort: 'price_desc', limit: '1', offset: '0' } }, res);
  assert.equal(res.data.total, 2);
  assert.deepEqual(res.data.products.map(p => p.id), ['102']);
});

test('productos?ids= responde id/precio/sku desde catalogo_productos', async () => {
  const seen = mockSupabase({ catalogo_productos: [{ id: 101, sku: 'GLB-1', price: 10 }, { id: 102, sku: 'VEL-1', price: 25 }], productos_migrados: MIGRADOS });
  const res = response();
  await require('../api/productos.js')({ query: { ids: '101,102,abc' } }, res);
  assert.deepEqual(res.data.products, [{ id: 101, price: 10, sku: 'GLB-1' }, { id: 102, price: 25, sku: 'VEL-MIG' }]);
  assert.ok(seen.some(u => u.includes('active=eq.true') && u.includes('id=in.(101,102)')));
});

test('crear-pedido: el precio sale de catalogo_productos, nunca del navegador', async () => {
  let saved = null;
  mockSupabase({
    catalogo_productos: [{ id: 101, name: 'Globo rojo', sku: 'GLB-1', price: 10, active: true }, { id: 103, name: 'Antifaz', sku: 'ANT-1', price: 5, active: false }],
    pedidos_online: (u, opts) => { saved = JSON.parse(opts.body); return []; }
  });
  const body = { items: [{ id: 101, qty: 3, price: 0.01 }], customer_name: 'Ana', customer_email: 'ana@test.mx', customer_phone: '5555', address: 'Calle 1', colonia: 'Centro', municipio: 'BJ', estado: 'CDMX', cp: '03100', shipping_cost: 99 };
  const res = response();
  await require('../api/crear-pedido.js')({ method: 'POST', body }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.subtotal, 30); assert.equal(res.data.total, 129);
  assert.equal(saved.items[0].price, 10);

  const res2 = response();
  await require('../api/crear-pedido.js')({ method: 'POST', body: { ...body, items: [{ id: 103, qty: 1 }] } }, res2);
  assert.equal(res2.code, 400, 'un producto inactivo no se puede comprar');
});

test('crear-pedido: recoger en tienda no pide dirección, no cobra envío y guarda la sucursal', async () => {
  let saved = null;
  mockSupabase({
    catalogo_productos: [{ id: 101, name: 'Globo rojo', sku: 'GLB-1', price: 10, active: true }],
    pedidos_online: (u, opts) => { saved = JSON.parse(opts.body); return []; }
  });
  const body = { items: [{ id: 101, qty: 3 }], customer_name: 'Ana', customer_email: 'ana@test.mx', customer_phone: '5555', pickup_branch: 'queretaro', shipping_cost: 99 };
  const res = response();
  await require('../api/crear-pedido.js')({ method: 'POST', body }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.total, 30, 'el costo de envío mandado por el navegador se ignora');
  assert.equal(saved.shipping_cost, 0);
  assert.equal(saved.shipping_carrier, 'Recoger en tienda - Querétaro');
  assert.match(saved.shipping_address, /^Recoger en tienda: Querétaro \(C\. Gral\. Lázaro Cárdenas 67/);

  const bad = response();
  await require('../api/crear-pedido.js')({ method: 'POST', body: { ...body, pickup_branch: 'luna' } }, bad);
  assert.equal(bad.code, 400);
  const sinDir = response();
  await require('../api/crear-pedido.js')({ method: 'POST', body: { ...body, pickup_branch: undefined } }, sinDir);
  assert.equal(sinDir.code, 400, 'a domicilio sigue exigiendo dirección');
});

test('stock-sucursal: existencias de ps_stock, sin las sucursales ocultas', async () => {
  const seen = mockSupabase({ ps_stock: [{ id_warehouse: 53, quantity: 12 }, { id_warehouse: 54, quantity: 7 }, { id_warehouse: 55, quantity: 3.4 }] });
  const res = response();
  await require('../api/stock-sucursal.js')({ query: { id: '101' } }, res);
  assert.deepEqual(res.data, { branches: [{ warehouseId: '53', name: 'CDMX Rumania', qty: 12 }, { warehouseId: '55', name: 'Puebla', qty: 3 }], total: 15 });
  assert.ok(seen.some(u => u.includes('id_product=eq.101')));
  const bad = response();
  await require('../api/stock-sucursal.js')({ query: { id: '1;drop' } }, bad);
  assert.equal(bad.code, 400);
});

test('categorias-tienda: conteo desde catalogo_productos + categorías migradas', async () => {
  mockSupabase({
    ps_categorias: [{ id: 269, name: 'Globos', link_rewrite: 'globos' }, { id: 270, name: 'Velas', link_rewrite: 'velas' }],
    catalogo_productos: [{ id: 101, category_id: 269 }, { id: 102, category_id: 270 }, { id: 103, category_id: 270 }],
    productos_migrados: [...MIGRADOS, { id: 999, category_ids: [269] }]
  });
  const res = response();
  await require('../api/categorias-tienda.js')({ query: {} }, res);
  const by = Object.fromEntries(res.data.categories.map(c => [c.id, c.count]));
  assert.deepEqual(by, { 269: 2, 270: 2 }, 'el 999 migrado pero inactivo no cuenta');
});

test('ventas: totales por tienda desde ps_pedidos (válidos, en pesos, por fecha)', async () => {
  const seen = mockSupabase({ ps_pedidos: [
    { id: 1, total_paid: 100, date_add: '2026-09-01T10:00:00+00:00', id_employee: 225 },
    { id: 2, total_paid: 50.5, date_add: '2026-09-02T10:00:00+00:00', id_employee: null }
  ] });
  const res = response();
  await require('../api/ventas.js')({ query: { from: '2026-09-01', to: '2026-09-30' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.revenue, 150.5); assert.equal(res.data.orders, 2);
  assert.deepEqual(res.data.breakdown.map(b => b.label), ['2026-09-01', '2026-09-02']);
  const by = Object.fromEntries(res.data.byStore.map(s => [s.store, s.revenue]));
  assert.equal(by['CDMX Rumania'], 100); assert.equal(by['Tienda en línea'], 50.5);
  const q = decodeURIComponent(seen.find(u => u.includes('ps_pedidos')));
  assert.ok(q.includes('valid=is.true') && q.includes('id_currency.eq.3') && q.includes('date_add=gte.2026-09-01 00:00:00') && q.includes('date_add=lte.2026-09-30 23:59:59'));
});

test('ventas-productos: agregado por producto y mes desde la vista', async () => {
  mockSupabase({ __count: 42, ps_pedidos: [], ps_ventas_producto_mes: [
    { product_id: 101, month: '2026-08', product_name: 'Globo', product_reference: 'GLB', units: 5, revenue: 50, lines: 2 },
    { product_id: 101, month: '2026-09', product_name: 'Globo', product_reference: 'GLB', units: 3, revenue: 30, lines: 1 },
    { product_id: 102, month: '2026-09', product_name: 'Vela', product_reference: 'VEL', units: 20, revenue: 500, lines: 4 }
  ] });
  const res = response();
  await require('../api/ventas-productos.js')({ query: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.data.products.map(p => [p.product_id, p.totalUnits, p.totalRevenue]), [['102', 20, 500], ['101', 8, 80]]);
  assert.deepEqual(res.data.products[1].byMonth, { '2026-08': { units: 5, revenue: 50 }, '2026-09': { units: 3, revenue: 30 } });
  assert.equal(res.data.ordersProcessed, 42); assert.equal(res.data.lineItemsProcessed, 7);
});

test('promo-paquetes: lista de artículos desde la descripción sincronizada (sin HTML)', async () => {
  mockSupabase({ catalogo_productos: [{ id: 83553, name: 'Promo Estándar', price: 599, description: 'Esta promo incluye 🥳5 Antifaz metálico \r\n1 Globo salchicha\r\n*Stock sujeto a bodega', description_short: null, link_rewrite: 'promo', images: ['https://sb/83553.jpg'] }] });
  const res = response();
  await require('../api/promo-paquetes.js')({ query: { ids: '83553' } }, res);
  assert.equal(res.code, 200);
  const [pkg] = res.data.packages;
  assert.deepEqual(pkg.items, ['5 Antifaz metálico', '1 Globo salchicha']);
  assert.equal(pkg.img, 'https://sb/83553.jpg'); assert.equal(pkg.price, 599);
});

test('paginas: página no migrada desde ps_cms_paginas y footer sin PrestaShop', async () => {
  mockSupabase({ ps_cms_paginas: [{ id: 420, slug: 'politica-de-envio-gratis-mi-fiesta-shop', title: 'Política de Envío Gratis Mi Fiesta Shop', description: 'd', content: '<p>Copia</p>', active: true }] });
  const handler = require('../api/paginas.js');
  let res = response();
  await handler({ query: { id: '420' } }, res);
  assert.equal(res.data.page.content, '<p>Copia</p>');
  res = response();
  await handler({ query: { slug: 'politica-de-envio-gratis-mi-fiesta-shop' } }, res);
  assert.equal(res.data.page.id, '420');
  res = response();
  await handler({ query: {} }, res);
  assert.deepEqual(res.data.pages.map(p => p.id), ['420']);

  // Sin copia sincronizada todavía: título del índice del repo + texto de respaldo.
  mockSupabase({ ps_cms_paginas: [] });
  res = response();
  await handler({ query: { id: '421' } }, res);
  assert.equal(res.code, 200); assert.equal(res.data.page.title, 'Política de Devolución Mi Fiesta Shop'); assert.match(res.data.page.content, /devoluci/i);
});

test('proveedores y sitemap desde Supabase', async () => {
  mockSupabase({ ps_proveedores: [{ id: 4, name: 'Globos SA', active: true }], catalogo_productos: [{ id: 101, link_rewrite: 'globo-rojo' }] });
  let res = response();
  await require('../api/proveedores.js')({ query: {} }, res);
  assert.deepEqual(res.data.suppliers.map(s => [s.id, s.name, s.status]), [[4, 'Globos SA', 'Activo']]);
  res = response();
  await require('../api/sitemap.js')({ query: {}, headers: { host: 'mifiestashop.vercel.app' } }, res);
  assert.match(res.sent, /https:\/\/mifiestashop\.vercel\.app\/101-globo-rojo\.html/);
});

test('url-producto: mismo formato de liga que PrestaShop', () => {
  const { productoPath } = require('../lib/url-producto.js');
  assert.equal(productoPath({ id: 83389, linkRewrite: 'bombin-neon', ean13: '9571834896571', categoryRewrite: 'neon-glow' }), '/neon-glow/83389-bombin-neon-9571834896571.html');
  assert.equal(productoPath({ id: 392, linkRewrite: 'promo-batucada-estandar-', ean13: '9807654321890', categoryRewrite: 'promociones' }), '/promociones/392-promo-batucada-estandar--9807654321890.html');
  assert.equal(productoPath({ id: 5, linkRewrite: 'x', ean13: '', categoryRewrite: '' }), '/5-x.html');
  assert.equal(productoPath({ id: 5, linkRewrite: '' }), '');
});
