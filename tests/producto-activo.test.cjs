const test = require('node:test'), assert = require('node:assert/strict');
const { runFullSync } = require('../lib/sync-prestashop.js');

function response() {
  return {
    code: 0, data: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; }
  };
}

test('syncProductos respeta active_override (no lo pisa) pero sí actualiza el resto de los campos', async () => {
  const upserts = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      if (u.includes('/api/products?')) return json({ products: [
        // 84601 tiene active_override en Supabase (desactivado a mano) —
        // PrestaShop dice que sigue activo, pero eso no debe pisar la
        // decisión manual.
        { id: '84601', reference: 'BND-1', price: '30', active: '1', name: 'Banda Despedida' },
        { id: '90000', reference: 'GLB-1', price: '10', active: '0', name: 'Globo normal' }
      ] });
      if (u.includes('/api/specific_prices?')) return json({ specific_prices: [] });
      return json({});
    }
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') return json(null);
      return json([]);
    }
    if (u.includes('/rest/v1/catalogo_productos') && u.includes('active_override=not.is.null')) {
      return json([{ id: 84601 }]);
    }
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'POST') {
      upserts.push(JSON.parse(opts.body));
      return json(null);
    }
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['productos'] });
    assert.equal(r.productos.ok, true, r.productos.error);

    // Dos lotes separados: uno sin "active" (el override) y otro con.
    const overriddenBatch = upserts.find(batch => batch.some(row => row.id === 84601));
    const normalBatch = upserts.find(batch => batch.some(row => row.id === 90000));
    assert.ok(overriddenBatch, 'debió mandar un lote con el producto con override');
    assert.ok(normalBatch, 'debió mandar un lote con el producto normal');
    assert.notEqual(overriddenBatch, normalBatch);

    const overriddenRow = overriddenBatch.find(row => row.id === 84601);
    assert.equal('active' in overriddenRow, false, 'no debe traer "active" en absoluto');
    assert.equal(overriddenRow.price, 30, 'el resto de los campos sí se sigue actualizando');
    assert.equal(overriddenRow.name, 'Banda Despedida');

    const normalRow = normalBatch.find(row => row.id === 90000);
    assert.equal(normalRow.active, false);
  } finally { global.fetch = prev; }
});

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
