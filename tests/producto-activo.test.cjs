const test = require('node:test'), assert = require('node:assert/strict');

function response() {
  return {
    code: 0, data: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; }
  };
}

test('api/producto-activo: sesión inválida no puede cambiar el estado', async () => {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rpc/rpc_check_session')) return { ok: true, json: async () => null };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = response();
    await require('../api/producto-activo.js')({ method: 'POST', body: { id: 84601, activo: false } }, res);
    assert.equal(res.code, 401);
  } finally { global.fetch = prev; }
});

test('api/producto-activo: marca active y active_override juntos, sin tocar nada más', async () => {
  let patchBody = null, patchUrl = null;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr-key';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rpc/rpc_check_session')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'PATCH') {
      patchUrl = u; patchBody = JSON.parse(opts.body);
      return { ok: true, json: async () => null };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = response();
    await require('../api/producto-activo.js')({ method: 'POST', body: { p_admin_password: 'x', id: 84601, activo: false } }, res);
    assert.equal(res.data.ok, true);
    assert.match(patchUrl, /id=eq\.84601/);
    assert.equal(patchBody.active, false);
    assert.equal(patchBody.active_override, false);
    assert.equal(Object.keys(patchBody).sort().join(','), ['active', 'active_override', 'updated_at'].sort().join(','));
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/productos-admin: trae activos e inactivos, requiere sesión', async () => {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rpc/rpc_check_session')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/rest/v1/catalogo_productos')) {
      return { ok: true, json: async () => [
        { id: 101, sku: 'GLB-1', name: 'Globo', price: 10, active: true, source: 'prestashop' },
        { id: 84601, sku: 'BND-1', name: 'Banda Despedida', price: 30, active: false, source: 'prestashop' }
      ] };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const res = response();
    await require('../api/productos-admin.js')({ method: 'POST', body: { p_admin_password: 'x' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.data.count, 2);
    const banda = res.data.products.find(p => p.id === '84601');
    assert.equal(banda.active, false);
    const globo = res.data.products.find(p => p.id === '101');
    assert.equal(globo.active, true);
  } finally { global.fetch = prev; }
});
