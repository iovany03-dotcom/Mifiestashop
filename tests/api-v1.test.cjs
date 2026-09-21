const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { authenticateApiRequest, hashKey } = require('../lib/api-auth.js');
const productsList = require('../api/v1/products/index.js');
const productDetail = require('../api/v1/products/[id].js');
const categoriesList = require('../api/v1/categories/index.js');
const ordersList = require('../api/v1/orders/index.js');
const orderDetail = require('../api/v1/orders/[id].js');
const customersList = require('../api/v1/customers/index.js');

function response() {
  return {
    code: 0, data: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; }
  };
}

const TEST_KEY = 'mfs_live_testkey1234567890';
const TEST_KEY_HASH = hashKey(TEST_KEY);
const API_KEY_ROW = { id: 1, nombre: 'Test App', scopes: ['products:read', 'products:write', 'categories:read', 'orders:read', 'orders:write', 'customers:read'], activo: true };

function withEnv(vars, fn) {
  const prev = {};
  for (const k in vars) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k in vars) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

function mockFetch(router) {
  const prev = global.fetch;
  global.fetch = async (url, opts) => router(String(url), opts || {});
  return () => { global.fetch = prev; };
}

function baseRouter(extra) {
  return async (url, opts) => {
    if (url.includes('/rest/v1/api_keys') && (!opts.method || opts.method === 'GET') && url.includes('key_hash')) {
      const match = url.includes(TEST_KEY_HASH);
      return { ok: true, json: async () => (match ? [API_KEY_ROW] : []) };
    }
    if (url.includes('/rest/v1/api_keys') && opts.method === 'PATCH') {
      return { ok: true, json: async () => ([]) };
    }
    const hit = extra && (await extra(url, opts));
    if (hit) return hit;
    throw new Error('unmocked fetch: ' + url);
  };
}

test('api-auth: rejects missing/invalid/wrong-scope, accepts valid key with scope', async () => {
  const restore = mockFetch(baseRouter());
  await withEnv({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const noHeader = await authenticateApiRequest({ headers: {} }, 'products:read');
    assert.equal(noHeader.ok, false); assert.equal(noHeader.status, 401);

    const badKey = await authenticateApiRequest({ headers: { authorization: 'Bearer mfs_live_wrong' } }, 'products:read');
    assert.equal(badKey.ok, false); assert.equal(badKey.status, 401);

    const wrongScope = await authenticateApiRequest({ headers: { authorization: `Bearer ${TEST_KEY}` } }, 'orders:write_that_does_not_exist');
    assert.equal(wrongScope.ok, false); assert.equal(wrongScope.status, 403);

    const ok = await authenticateApiRequest({ headers: { authorization: `Bearer ${TEST_KEY}` } }, 'products:read');
    assert.equal(ok.ok, true); assert.equal(ok.key.nombre, 'Test App');
  });
  restore();
});

test('GET /api/v1/products requires auth and returns full-catalog products, no price/stock write leakage', async () => {
  const psProduct = {
    id: 83101, name: 'Vela de Bengala', reference: 'VEL-BEN', price: '10.00',
    id_default_image: '33604', id_category_default: '270', active: '1',
    description_short: '<p>Corta</p>', link_rewrite: 'vela-de-bengala'
  };
  const restore = mockFetch(baseRouter(async (url) => {
    if (url.includes('/api/products?display') && url.includes('limit=0,50')) return { ok: true, json: async () => ({ products: [psProduct] }) };
    if (url.includes('/api/products?display=%5Bid%5D')) return { ok: true, json: async () => ({ products: [psProduct] }) };
    if (url.includes('/rest/v1/productos_migrados?id=in.')) return { ok: true, json: async () => ([]) };
  }));
  await withEnv({ PS_API_KEY: 'ps-key', PS_BASE_URL: 'https://ps.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const noAuth = response();
    await productsList({ method: 'GET', headers: {}, query: {} }, noAuth);
    assert.equal(noAuth.code, 401);

    const ok = response();
    await productsList({ method: 'GET', headers: { authorization: `Bearer ${TEST_KEY}` }, query: {} }, ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.data.data.length, 1);
    assert.equal(ok.data.data[0].name, 'Vela de Bengala');
    assert.equal(ok.data.data[0].price, 10);
    assert.equal(ok.data.meta.total, 1);
  });
  restore();
});

test('PATCH /api/v1/products/:id rejects price/stock edits and updates descriptive fields', async () => {
  const psProduct = { id: 83101, name: 'Vela de Bengala', reference: 'VEL-BEN', active: '1' };
  const restore = mockFetch(baseRouter(async (url, opts) => {
    if (url.includes('/api/products/83101?display')) return { ok: true, json: async () => ({ product: psProduct }) };
    if (url.includes('/rest/v1/productos_migrados?id=eq.83101') && (!opts.method || opts.method === 'GET')) return { ok: true, json: async () => ([]) };
    if (url.includes('/rest/v1/productos_migrados?on_conflict=id') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ([{ ...body }]) };
    }
  }));
  await withEnv({ PS_API_KEY: 'ps-key', PS_BASE_URL: 'https://ps.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const rejected = response();
    await productDetail({ method: 'PATCH', headers: { authorization: `Bearer ${TEST_KEY}` }, query: { id: '83101' }, body: { price: 999 } }, rejected);
    assert.equal(rejected.code, 422);
    assert.equal(rejected.data.error.code, 'read_only_field');

    const ok = response();
    await productDetail({ method: 'PATCH', headers: { authorization: `Bearer ${TEST_KEY}` }, query: { id: '83101' }, body: { description: 'Nueva descripción' } }, ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.data.data.description, 'Nueva descripción');
  });
  restore();
});

test('GET /api/v1/categories returns active categories only, paginated', async () => {
  const restore = mockFetch(baseRouter(async (url) => {
    if (url.includes('/rest/v1/ps_categorias')) {
      assert.ok(url.includes('active=eq.true'));
      return { ok: true, json: async () => ([{ id: 270, name: 'VELAS', id_parent: 2 }]) };
    }
  }));
  await withEnv({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const ok = response();
    await categoriesList({ method: 'GET', headers: { authorization: `Bearer ${TEST_KEY}` }, query: {} }, ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.data.data[0].name, 'Velas');
  });
  restore();
});

test('POST /api/v1/orders revalidates price live from PrestaShop, ignoring client-supplied price', async () => {
  const restore = mockFetch(baseRouter(async (url, opts) => {
    if (url.includes('/api/products/83101?display')) {
      return { ok: true, json: async () => ({ products: [{ id: 83101, name: 'Vela de Bengala', reference: 'VEL-BEN', price: '10.00', active: '1' }] }) };
    }
    if (url.includes('/rest/v1/pedidos_online') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      assert.equal(body.items[0].price, 10); // never the client price (99999) below
      assert.equal(body.subtotal, 20);
      return { ok: true, json: async () => ([{ id: 1, ...body }]) };
    }
  }));
  await withEnv({ PS_API_KEY: 'ps-key', PS_BASE_URL: 'https://ps.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const ok = response();
    await ordersList({
      method: 'POST', headers: { authorization: `Bearer ${TEST_KEY}` }, query: {},
      body: {
        items: [{ id: 83101, qty: 2, price: 99999 }],
        customer_name: 'Ana', customer_email: 'ana@example.com', customer_phone: '5512345678',
        shipping_address: 'Calle 123', shipping_cost: 0
      }
    }, ok);
    assert.equal(ok.code, 201);
    assert.equal(ok.data.data.total, 20);
  });
  restore();
});

test('PATCH /api/v1/orders/:id rejects invalid status and accepts a valid one', async () => {
  const restore = mockFetch(baseRouter(async (url, opts) => {
    if (url.includes('/rest/v1/pedidos_online?id=eq.1') && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ([{ id: 1, folio: 'API-000001', status: body.status, items: [], subtotal: 20, total: 20 }]) };
    }
  }));
  await withEnv({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const rejected = response();
    await orderDetail({ method: 'PATCH', headers: { authorization: `Bearer ${TEST_KEY}` }, query: { id: '1' }, body: { status: 'Volando' } }, rejected);
    assert.equal(rejected.code, 422);

    const ok = response();
    await orderDetail({ method: 'PATCH', headers: { authorization: `Bearer ${TEST_KEY}` }, query: { id: '1' }, body: { status: 'Enviado' } }, ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.data.data.status, 'Enviado');
  });
  restore();
});

test('GET /api/v1/customers requires customers:read scope', async () => {
  const restore = mockFetch(baseRouter(async (url) => {
    if (url.includes('/rest/v1/ps_clientes')) return { ok: true, headers: new Map([['content-range', '0-0/1']]), json: async () => ([{ id: 5, name: 'Ana', email: 'ana@example.com', date_add: '2026-01-01' }]) };
  }));
  await withEnv({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' }, async () => {
    const ok = response();
    await customersList({ method: 'GET', headers: { authorization: `Bearer ${TEST_KEY}` }, query: {} }, ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.data.data[0].name, 'Ana');
  });
  restore();
});
