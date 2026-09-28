const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const handler = require('../api/ajustes-tienda.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body }, res).then(() => res);
}

test('ajustes-tienda: sin sesión no cambia nada', async () => {
  const urls = [];
  global.fetch = async url => { urls.push(String(url)); return { ok: true, json: async () => false }; };
  const r = await call({ p_admin_password: 'mala', mostrarStockSucursal: true });
  assert.equal(r.code, 401);
  assert.ok(urls.every(u => !u.includes('ajustes_pago')));
});

test('ajustes-tienda: con sesión guarda solo el interruptor', async () => {
  let patch = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return { ok: true, json: async () => true };
    if (u.includes('ajustes_pago')) { patch = JSON.parse(opts.body); return { ok: true, json: async () => [{ id: 1, mostrar_stock_sucursal: patch.mostrar_stock_sucursal }], text: async () => '' }; }
    return { ok: false, json: async () => ({}) };
  };
  let r = await call({ p_admin_password: 'buena', mostrarStockSucursal: 'si' });
  assert.equal(r.code, 400);
  r = await call({ p_admin_password: 'buena', mostrarStockSucursal: false });
  assert.equal(r.code, 200); assert.equal(r.data.mostrarStockSucursal, false);
  assert.deepEqual(Object.keys(patch).sort(), ['mostrar_stock_sucursal', 'updated_at']);
});
