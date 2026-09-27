const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/clientes-web.js');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body }, res).then(() => res);
}

test('clientes-web: sin sesión válida responde 401 y no lee auth.users', async () => {
  const urls = [];
  global.fetch = async url => { urls.push(String(url)); return { ok: true, json: async () => false }; };
  const r = await call({ p_admin_password: 'mala' });
  assert.equal(r.code, 401);
  assert.ok(urls.every(u => !u.includes('/auth/v1/admin/users')));
});

test('clientes-web: con sesión devuelve las cuentas web con estado de confirmación', async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return { ok: true, json: async () => ({ role: 'admin' }) };
    if (u.includes('/auth/v1/admin/users')) {
      assert.equal(opts.headers.Authorization, 'Bearer service-role-test');
      return { ok: true, json: async () => ({ users: [
        { id: '1add2e3a-bc97-41bf-be6e-ffe0684e8acf', email: 'mifiestashop@gmail.com', created_at: '2026-09-27T19:16:57Z', email_confirmed_at: '2026-09-27T19:31:16Z', user_metadata: { full_name: 'MFS', phone: '551315444' } },
        { id: 'abcdef12-0000-0000-0000-000000000000', email: 'nuevo@test.mx', created_at: '2026-09-28T10:00:00Z', email_confirmed_at: null, user_metadata: {} }
      ] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  const r = await call({ p_admin_password: 'buena' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.data.customers.map(c => [c.id, c.name, c.email, c.phone, c.date, c.status]), [
    ['WEB-ABCDEF12', 'nuevo', 'nuevo@test.mx', '—', '2026-09-28', 'Sin confirmar'],
    ['WEB-1ADD2E3A', 'MFS', 'mifiestashop@gmail.com', '551315444', '2026-09-27', 'Cuenta web']
  ]);
});
