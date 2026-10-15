const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/promo-paquetes.js');

function call(query) {
  const res = { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ query }, res).then(() => res);
}
function withFetch(fn) {
  return async () => {
    const prev = global.fetch;
    try { await fn(); } finally { global.fetch = prev; }
  };
}
const ESTANDAR_ROW = { id: 83553, name: 'Promo Batucada Estandar', price: '599', description: '5 Antifaz\n1 Globo', description_short: '', link_rewrite: 'promo', images: ['https://sb/83553.jpg'] };
const VIP_ROW = { id: 10790464092173, name: 'Promo Batucada VIP', price: '1700', description: '<p>Esta promo incluye</p><ul><li>12 Collar hawaiano neón</li><li>10 Bombín neón</li></ul><p>*Stock sujeto a bodega</p>', description_short: 'x', link_rewrite: 'promo-batucada-vip', legacy_image_url: null, images: null };

test('promo-paquetes junta los paquetes de catalogo_productos en el orden pedido', withFetch(async () => {
  global.fetch = async url => {
    const u = String(url);
    if (u.includes('/rest/v1/catalogo_productos')) return { ok: true, json: async () => [VIP_ROW, ESTANDAR_ROW] };
    return { ok: true, json: async () => [] };
  };
  const r = await call({ ids: '83553,10790464092173' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.data.packages.map(p => p.id), [83553, 10790464092173]);
  const [estandar, vip] = r.data.packages;
  assert.equal(estandar.price, 599); assert.equal(estandar.img, 'https://sb/83553.jpg');
  assert.equal(estandar.url, 'https://www.mifiestashop.com/83553-promo.html');
  assert.equal(vip.name, 'Promo Batucada VIP'); assert.equal(vip.price, 1700);
  assert.deepEqual(vip.items, ['12 Collar hawaiano neón', '10 Bombín neón']);
  assert.equal(vip.url, undefined, 'un paquete propio no tiene liga /{id}-{slug}.html');
}));

test('promo-paquetes sin ids válidos responde 400', withFetch(async () => {
  global.fetch = async () => { throw new Error('no debe consultar nada'); };
  const r = await call({ ids: 'abc' });
  assert.equal(r.code, 400); assert.deepEqual(r.data.packages, []);
}));
