const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/costo-compra.js');

function response() {
  return {
    code: 0, data: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; }
  };
}

function mockFetch({ claveOk = true, conCosto = [] } = {}) {
  const patches = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('/rpc/rpc_check_edit')) return json(claveOk);
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'PATCH') {
      const id = Number(/id=eq\.(\d+)/.exec(u)[1]);
      patches.push({ url: u, body: JSON.parse(opts.body) });
      return json(conCosto.includes(id) ? [] : [{ id }]);
    }
    throw new Error('fetch inesperado: ' + u);
  };
  return patches;
}

test('llena solo costo_compra y solo donde está vacío', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const patches = mockFetch({ conCosto: [2] });
  try {
    const res = response();
    await handler({ method: 'POST', body: { p_edit_password: 'x', items: [{ id: 1, costo: 3.5 }, { id: 2, costo: 9 }] } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.data.actualizados, [1]);
    assert.deepEqual(res.data.omitidos, [2]);
    for (const p of patches) {
      assert.ok(p.url.includes('costo_compra=is.null'), 'el PATCH debe filtrar costo_compra vacío');
      assert.deepEqual(Object.keys(p.body).sort(), ['costo_compra', 'updated_at']);
    }
  } finally { global.fetch = prev; }
});

test('rechaza sin la clave de edición', async () => {
  const prev = global.fetch;
  const patches = mockFetch({ claveOk: false });
  try {
    const res = response();
    await handler({ method: 'POST', body: { p_edit_password: 'mala', items: [{ id: 1, costo: 3 }] } }, res);
    assert.equal(res.code, 401);
    assert.equal(patches.length, 0);
  } finally { global.fetch = prev; }
});

test('rechaza costos inválidos sin escribir nada', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const patches = mockFetch();
  try {
    const res = response();
    await handler({ method: 'POST', body: { p_edit_password: 'x', items: [{ id: 1, costo: 3 }, { id: 2, costo: 0 }] } }, res);
    assert.equal(res.code, 400);
    assert.equal(patches.length, 0);
  } finally { global.fetch = prev; }
});
