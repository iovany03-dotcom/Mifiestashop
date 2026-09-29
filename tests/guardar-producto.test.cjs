const test = require('node:test'), assert = require('node:assert/strict');

function response() {
  return {
    code: 0, data: null,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; }
  };
}

test('api/guardar-producto: al editar un producto existente no borra category_id/SEO/link_rewrite/source', async () => {
  let posted = null;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr-key';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rpc/rpc_check_session')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'POST') {
      posted = JSON.parse(opts.body)[0];
      return { ok: true, json: async () => null, text: async () => '' };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = response();
    await require('../api/guardar-producto.js')({
      method: 'POST',
      body: { p_admin_password: 'x', producto: { id: 84650, sku: 'BND-1', name: 'Pantuflas para xv años', price: 42, priceMayoreo: 37, priceMayoreoDesdeUnidades: 200, active: true } }
    }, res);
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    // El bug real: se mandaba "wholesale_price" (columna que no existe) en
    // vez de "price_mayoreo" — Supabase rechazaba la fila entera con 400.
    assert.equal(posted.price_mayoreo, 37);
    assert.equal('wholesale_price' in posted, false);
    // Este editor no tiene campos para estos — no deben ir en el payload de
    // un producto YA EXISTENTE (se dejarían en null y borrarían lo real).
    for (const key of ['category_id', 'meta_title', 'meta_description', 'meta_keywords', 'link_rewrite', 'description_short', 'source']) {
      assert.equal(key in posted, false, `no debería incluir "${key}" al editar`);
    }
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/guardar-producto: al crear uno nuevo sí fija esos campos (nada que perder) y source=manual', async () => {
  let posted = null;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr-key';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rpc/rpc_check_session')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'POST') {
      posted = JSON.parse(opts.body)[0];
      return { ok: true, json: async () => null, text: async () => '' };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = response();
    await require('../api/guardar-producto.js')({
      method: 'POST',
      body: { p_admin_password: 'x', producto: { sku: 'NEW-1', name: 'Producto nuevo', price: 99 } }
    }, res);
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    assert.equal(posted.source, 'manual');
    assert.equal(posted.category_id, null);
    assert.equal(posted.link_rewrite, null);
    assert.ok(posted.id > 9000000000000);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/guardar-producto: sin sesión válida no guarda nada', async () => {
  const prev = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/rpc/rpc_check_session')) return { ok: true, json: async () => null };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const res = response();
    await require('../api/guardar-producto.js')({ method: 'POST', body: { producto: { sku: 'X', name: 'X', price: 1 } } }, res);
    assert.equal(res.code, 401);
  } finally { global.fetch = prev; }
});
