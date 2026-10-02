const test = require('node:test'), assert = require('node:assert/strict');
delete process.env.PRESTASHOP_CONECTADO;
const handler = require('../api/ventas-productos.js');

function call() {
  const res = { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ query: {} }, res).then(() => res);
}
function withEnv(key, fn) {
  return async () => {
    const prev = { fetch: global.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    try { await fn(); } finally {
      global.fetch = prev.fetch;
      if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    }
  };
}
const PS_ROWS = [
  { product_id: 83312, month: '2026-09', product_name: 'Pompones metálicos', product_reference: 'pompon', units: '10', revenue: '200', lines: 2 },
  { product_id: 83108, month: '2026-09', product_name: 'Microfono', product_reference: 'mic', units: '4', revenue: '32', lines: 1 }
];
const POS_ROWS = [
  { product_id: 83312, month: '2026-09', product_name: 'Pompones metálicos', product_reference: 'pompon', units: '5', revenue: '100', lines: 1 },
  { product_id: 83312, month: '2026-10', product_name: 'Pompones metálicos', product_reference: 'pompon', units: '3', revenue: '60', lines: 1 },
  { product_id: 85217, month: '2026-10', product_name: 'Papel picado', product_reference: 'pp', units: '7', revenue: '70', lines: 1 }
];
function mockFetch(posOk) {
  const urls = [];
  global.fetch = async (url, opts) => {
    const u = String(url); urls.push({ u, key: opts && opts.headers && opts.headers.apikey });
    if (u.includes('/rest/v1/ps_ventas_producto_mes')) return { ok: true, json: async () => PS_ROWS };
    if (u.includes('/rest/v1/pos_ventas_producto_mes')) return posOk ? { ok: true, json: async () => POS_ROWS } : { ok: false, status: 500, json: async () => ({}) };
    if (u.includes('/rest/v1/ps_pedidos')) return { ok: true, headers: { get: () => '0-0/2' }, json: async () => [] };
    return { ok: true, json: async () => [] };
  };
  return urls;
}

test('ventas-productos suma las ventas del POS propio a las de PrestaShop (mismo producto y mes se juntan)', withEnv('service-test', async () => {
  const urls = mockFetch(true);
  const r = await call();
  assert.equal(r.code, 200); assert.equal(r.data.posIncluido, true); assert.equal(r.data.posError, undefined);
  const by = Object.fromEntries(r.data.products.map(p => [p.product_id, p]));
  assert.equal(by['83312'].totalUnits, 18); assert.equal(by['83312'].totalRevenue, 360);
  assert.deepEqual(by['83312'].byMonth, { '2026-09': { units: 15, revenue: 300 }, '2026-10': { units: 3, revenue: 60 } });
  assert.equal(by['83108'].totalUnits, 4);
  assert.equal(by['85217'].totalUnits, 7, 'producto vendido solo en el POS propio tambien aparece');
  assert.equal(r.data.lineItemsProcessed, 6);
  const posCall = urls.find(x => x.u.includes('pos_ventas_producto_mes'));
  assert.equal(posCall.key, 'service-test', 'la vista privada se lee con la llave de servicio');
}));

test('ventas-productos avisa si no hay llave de servicio, y sigue entregando lo de PrestaShop', withEnv(undefined, async () => {
  mockFetch(true);
  const r = await call();
  assert.equal(r.code, 200); assert.equal(r.data.posIncluido, false); assert.match(r.data.posError, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(r.data.products.length, 2);
}));

test('ventas-productos avisa si falla la lectura del POS, y sigue entregando lo de PrestaShop', withEnv('service-test', async () => {
  mockFetch(false);
  const r = await call();
  assert.equal(r.code, 200); assert.equal(r.data.posIncluido, false); assert.match(r.data.posError, /HTTP 500/);
  assert.equal(r.data.products.find(p => p.product_id === '83312').totalUnits, 10);
}));
