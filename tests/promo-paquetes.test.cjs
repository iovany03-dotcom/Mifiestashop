const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/promo-paquetes.js');

function call(query) {
  const res = { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ query }, res).then(() => res);
}
function withEnv(fn) {
  return async () => {
    const prev = { fetch: global.fetch, key: process.env.PS_API_KEY, base: process.env.PS_BASE_URL };
    process.env.PS_API_KEY = 'k'; process.env.PS_BASE_URL = 'https://ps.test';
    try { await fn(); } finally {
      global.fetch = prev.fetch;
      for (const [k, v] of [['PS_API_KEY', prev.key], ['PS_BASE_URL', prev.base]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}
const VIP_ROW = { id: 10790464092173, name: 'Promo Batucada VIP', price: '1700', description: '<p>Esta promo incluye</p><ul><li>12 Collar hawaiano neón</li><li>10 Bombín neón</li></ul><p>*Stock sujeto a bodega</p>', description_short: 'x', link_rewrite: 'promo-batucada-vip', legacy_image_url: null, images: null };

test('promo-paquetes junta paquetes de PrestaShop y paquetes propios de catalogo_productos', withEnv(async () => {
  const psUrls = [];
  global.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://ps.test/api/products?')) { psUrls.push(decodeURIComponent(u)); return { ok: true, json: async () => ({ products: [{ id: '83553', active: '1', name: 'Promo Batucada Estandar', price: '599.000000', description: '<ul><li>5 Antifaz</li><li>1 Globo</li></ul>', description_short: '', link_rewrite: 'promo', id_default_image: '0' }] }) }; }
    if (u.includes('/rest/v1/catalogo_productos')) return { ok: true, json: async () => [VIP_ROW] };
    return { ok: true, json: async () => [] };
  };
  const r = await call({ ids: '83553,10790464092173' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.data.packages.map(p => p.id), [83553, 10790464092173]);
  const vip = r.data.packages[1];
  assert.equal(vip.name, 'Promo Batucada VIP'); assert.equal(vip.price, 1700);
  assert.deepEqual(vip.items, ['12 Collar hawaiano neón', '10 Bombín neón']);
  assert.ok(psUrls.every(u => !u.includes('10790464092173')));
}));

test('promo-paquetes sigue mostrando el paquete propio aunque PrestaShop falle', withEnv(async () => {
  global.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://ps.test/api/products?')) return { ok: false, status: 500, text: async () => 'boom' };
    if (u.includes('/rest/v1/catalogo_productos')) return { ok: true, json: async () => [VIP_ROW] };
    return { ok: true, json: async () => [] };
  };
  const r = await call({ ids: '83553,10790464092173' });
  assert.equal(r.code, 200); assert.deepEqual(r.data.packages.map(p => p.id), [10790464092173]);
}));

test('promo-paquetes responde 502 si PrestaShop falla y no hay ningun paquete propio', withEnv(async () => {
  global.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://ps.test/api/products?')) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, json: async () => [] };
  };
  const r = await call({ ids: '83553' });
  assert.equal(r.code, 502); assert.deepEqual(r.data.packages, []);
}));
