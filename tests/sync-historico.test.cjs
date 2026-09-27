const test = require('node:test'), assert = require('node:assert/strict');
const { runFullSync } = require('../lib/sync-prestashop.js');

test('pedidos_historico baja desde el pedido más viejo de ps_pedidos y marca completo', async () => {
  const upserts = [], estados = [], psUrls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      psUrls.push(u);
      if (u.includes('/api/orders?')) return json({ orders: [
        { id: '998', reference: 'A', id_customer: '5', current_state: '2', date_add: '2026-01-10 12:00:00', id_employee: '225', total_paid: '100', valid: '1', id_currency: '3', conversion_rate: '1.000000' },
        { id: '997', reference: 'B', id_customer: '5', current_state: '2', date_add: '2026-01-09 12:00:00', id_employee: '0', total_paid: '50', valid: '1', id_currency: '3' }
      ] });
      if (u.includes('/api/order_details?')) return json({ order_details: [{ id_order: '998', product_id: '101', product_name: 'Globo', product_reference: 'GLB', product_quantity: '2', product_price: '50' }] });
      if (u.includes('/api/customers?')) return json({ customers: [{ id: '5', firstname: 'Ana', lastname: 'L' }] });
      return json({});
    }
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') { estados.push(JSON.parse(opts.body)); return json(null); }
      return json([]);
    }
    if (u.includes('/rest/v1/ps_pedidos') && opts.method === 'POST') { upserts.push(...JSON.parse(opts.body)); return json(null); }
    if (u.includes('/rest/v1/ps_pedidos')) return json([{ id: 1000 }]);
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['pedidos_historico'] });
    assert.equal(r.pedidos_historico.ok, true, r.pedidos_historico.error);
    assert.equal(r.pedidos_historico.count, 2);
    assert.ok(psUrls.some(u => u.includes('/api/orders?') && u.includes('filter[id]=[1,999]') && u.includes('sort=[id_DESC]')));
    assert.deepEqual(upserts.map(o => [o.id, o.id_currency, o.conversion_rate, o.customer_name]), [[998, 3, 1, 'Ana L'], [997, 3, null, 'Ana L']]);
    assert.deepEqual(upserts[0].items, [{ product_id: 101, name: 'Globo', sku: 'GLB', qty: 2, price: 50 }]);
    const last = estados[estados.length - 1];
    assert.equal(last.dominio, 'pedidos_historico'); assert.equal(last.last_synced_id, 997); assert.match(last.ultimo_resultado, /^completo/);
  } finally { global.fetch = prev; }
});

test('movimientos_nuevos sube desde el último movimiento guardado, solo bodegas propias, sin reiniciar el cursor', async () => {
  const upserts = [], estados = [], psUrls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      psUrls.push(u);
      return json({ stock_mvts: [
        { id: '401154', id_warehouse: '53', id_product: '83554', sign: '-1', physical_quantity: '1.00000', date_add: '2026-09-24 10:00:00' },
        { id: '401155', id_warehouse: '32', id_product: '999', sign: '1', physical_quantity: '5.00000', date_add: '2026-09-24 10:01:00' },
        { id: '401160', id_warehouse: '56', id_product: '83392', sign: '1', physical_quantity: '12.00000', date_add: '2026-09-24 11:00:00' }
      ] });
    }
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') { estados.push(JSON.parse(opts.body)); return json(null); }
      return json([]);
    }
    if (u.includes('/rest/v1/ps_inventory_movements') && opts.method === 'POST') { upserts.push(...JSON.parse(opts.body)); return json(null); }
    if (u.includes('/rest/v1/ps_inventory_movements')) return json([{ id: 401153 }]);
    if (u.includes('/rest/v1/ps_almacenes')) return json([{ id: 53 }, { id: 55 }, { id: 56 }]);
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['movimientos_nuevos'] });
    assert.equal(r.movimientos_nuevos.ok, true, r.movimientos_nuevos.error);
    assert.equal(r.movimientos_nuevos.count, 2);
    assert.ok(psUrls[0].includes('filter[id]=[401154,999999999]') && psUrls[0].includes('sort=[id_ASC]'));
    assert.deepEqual(upserts.map(m => m.id), [401154, 401160], 'descarta la bodega 32 de otra tienda');
    const last = estados[estados.length - 1];
    assert.equal(last.dominio, 'movimientos_nuevos'); assert.equal(last.last_synced_id, 401160); assert.match(last.ultimo_resultado, /^al día/);
  } finally { global.fetch = prev; }
});

test('movimientos_2anios: bodegas propias o bodega 0 con producto de la tienda, de hace 2 años para acá', async () => {
  const upserts = [], estados = [], psUrls = [];
  const prev = global.fetch;
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) + ' 10:00:00';
  const old = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10) + ' 10:00:00';
  const light = [
    { id: '10', id_warehouse: '0', id_product: '83392', date_add: old },      // muy viejo: fuera
    { id: '11', id_warehouse: '0', id_product: '83392', date_add: recent },   // bodega 0, producto propio: dentro
    { id: '12', id_warehouse: '0', id_product: '999', date_add: recent },     // bodega 0, producto de otra tienda: fuera
    { id: '13', id_warehouse: '32', id_product: '83392', date_add: recent },  // bodega de otra tienda: fuera
    { id: '14', id_warehouse: '55', id_product: '84000', date_add: recent }   // bodega propia: dentro
  ];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      psUrls.push(u);
      if (u.includes('display=full')) return json({ stock_mvts: [{ id: '11', id_warehouse: '0', id_product: '83392' }, { id: '14', id_warehouse: '55', id_product: '84000' }] });
      return json({ stock_mvts: light });
    }
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') { estados.push(JSON.parse(opts.body)); return json(null); }
      return json([]);
    }
    if (u.includes('/rest/v1/ps_inventory_movements') && opts.method === 'POST') { upserts.push(...JSON.parse(opts.body)); return json(null); }
    if (u.includes('/rest/v1/ps_almacenes')) return json([{ id: 53 }, { id: 55 }, { id: 56 }]);
    if (u.includes('/rest/v1/catalogo_productos')) return json([{ id: 83392 }, { id: 84000 }]);
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['movimientos_2anios'] });
    assert.equal(r.movimientos_2anios.ok, true, r.movimientos_2anios.error);
    assert.deepEqual(upserts.map(m => m.id), [11, 14]);
    assert.ok(psUrls.some(u => u.includes('display=full') && u.includes('filter[id]=[11|14]')));
    const last = estados[estados.length - 1];
    assert.equal(last.last_synced_id, 14); assert.match(last.ultimo_resultado, /^completo: desde=\d{4}-\d{2}-\d{2};guardados=2/);
  } finally { global.fetch = prev; }
});

test('carritos: solo guarda los de Mi Fiestashop (tienda 50) y sin la llave de PrestaShop en las imágenes', async () => {
  const upserts = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      if (u.includes('/api/carts?')) return json({ carts: [
        { id: '524838', id_customer: '0', id_shop: '12', date_add: '2026-09-27 14:29:54', date_upd: '2026-09-27 14:29:54' },
        { id: '524819', id_customer: '0', id_shop: '50', date_add: '2026-09-27 12:48:23', date_upd: '2026-09-27 12:48:23' }
      ] });
      if (u.includes('/api/carts/524819')) return json({ cart: { associations: { cart_rows: [{ id_product: '83409', quantity: '20' }] } } });
      if (u.includes('/api/products?')) return json({ products: [{ id: '83409', name: 'Sombrero Vaquero Neón', reference: 'SVN', price: '10.000000' }] });
      return json({});
    }
    if (u.includes('/rest/v1/catalogo_productos')) return json([{ id: 83409, images: ['https://sb.test/storage/83409.jpg'] }]);
    if (u.includes('/rest/v1/ps_carritos') && opts.method === 'POST') { upserts.push(...JSON.parse(opts.body)); return json(null); }
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'llave-secreta', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['carritos'] });
    assert.equal(r.carritos.ok, true, r.carritos.error);
    assert.deepEqual(upserts.map(c => [c.id, c.id_shop]), [[524819, 50]]);
    assert.deepEqual(upserts[0].items, [{ id_product: 83409, qty: 20, name: 'Sombrero Vaquero Neón', sku: 'SVN', price: 10, img: 'https://sb.test/storage/83409.jpg' }]);
    assert.ok(!JSON.stringify(upserts).includes('llave-secreta'));
  } finally { global.fetch = prev; }
});
