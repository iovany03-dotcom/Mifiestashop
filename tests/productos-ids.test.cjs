const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/productos.js');

function call(query) {
  const res = { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ query }, res).then(() => res);
}

test('productos?ids= devuelve solo id, precio y SKU de esos productos, sin imagen ni llave', async () => {
  const prev = { fetch: global.fetch, key: process.env.PS_API_KEY, base: process.env.PS_BASE_URL };
  process.env.PS_API_KEY = 'llave-secreta'; process.env.PS_BASE_URL = 'https://ps.test';
  const psUrls = [];
  global.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://ps.test/api/products?')) {
      psUrls.push(u);
      return { ok: true, json: async () => ({ products: [
        { id: '83423', name: 'Sombrero', price: '65.000000', reference: 'Hule espuma, sombrero', id_default_image: '55', link_rewrite: 'sombrero' },
        { id: '83424', name: 'Sombrero 2', price: '70.500000', reference: '', id_default_image: '56', link_rewrite: 'sombrero-2' }
      ] }) };
    }
    if (u.includes('specific_prices')) return { ok: true, json: async () => ({ specific_prices: [] }) };
    return { ok: true, json: async () => [] };
  };
  try {
    const r = await call({ ids: '83423, 83424,abc,83423,;drop' });
    assert.equal(r.code, 200);
    assert.deepEqual(r.data.products, [
      { id: 83423, price: 65, sku: 'Hule espuma, sombrero' },
      { id: 83424, price: 70.5, sku: 'PS-83424' }
    ]);
    assert.equal(r.data.count, 2);
    assert.ok(!JSON.stringify(r.data).includes('llave-secreta'));
    assert.ok(psUrls.every(u => u.includes('filter%5Bid%5D=') || u.includes('filter[id]=')));
    assert.ok(psUrls.some(u => decodeURIComponent(u).includes('[83423|83424]')), 'pide solo los ids validos y sin repetir');
    assert.match(r.headers['Cache-Control'], /s-maxage=120/);
  } finally {
    global.fetch = prev.fetch;
    for (const [k, v] of [['PS_API_KEY', prev.key], ['PS_BASE_URL', prev.base]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('productos?ids= sin ids validos responde vacio sin consultar productos', async () => {
  const prev = { fetch: global.fetch, key: process.env.PS_API_KEY, base: process.env.PS_BASE_URL };
  process.env.PS_API_KEY = 'k'; process.env.PS_BASE_URL = 'https://ps.test';
  let psCalls = 0;
  global.fetch = async url => { if (String(url).startsWith('https://ps.test/api/products?')) psCalls++; return { ok: true, json: async () => ({ specific_prices: [] }) }; };
  try {
    const r = await call({ ids: 'x,y' });
    assert.equal(r.code, 200); assert.deepEqual(r.data.products, []); assert.equal(psCalls, 0);
  } finally {
    global.fetch = prev.fetch;
    for (const [k, v] of [['PS_API_KEY', prev.key], ['PS_BASE_URL', prev.base]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
