const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/cliente-admin.js');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const UID = '1add2e3a-bc97-41bf-be6e-ffe0684e8acf';

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body: { p_admin_password: 'x', ...body } }, res).then(() => res);
}
function mock(routes, session = true) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const call = { url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    if (u.includes('rpc_check_session')) return { ok: true, text: async () => '', json: async () => (session ? { role: 'admin' } : false) };
    for (const [pattern, fn] of routes) {
      if (u.includes(pattern) && (!fn.method || fn.method === call.method)) {
        const [status, data] = fn(call);
        return { ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data };
      }
    }
    return { ok: true, status: 200, text: async () => '[]', json: async () => ({ users: [] }) };
  };
  return calls;
}
const route = (method, fn) => Object.assign(fn, { method });

test('cliente-admin: sin sesión responde 401 y no toca nada', async () => {
  const calls = mock([], false);
  const r = await call({ accion: 'eliminar', origen: 'prestashop', id: 5 });
  assert.equal(r.code, 401);
  assert.ok(calls.every(c => c.url.includes('rpc_check_session')));
});

test('cliente-admin: guardar un cliente de PrestaShop con contraseña le crea el acceso web', async () => {
  const calls = mock([
    ['/rest/v1/ps_clientes', route('PATCH', c => [200, [{ id: 94506, name: c.body.name, email: c.body.email, phone: c.body.phone, active: c.body.active, newsletter: c.body.newsletter, date_add: '2021-07-21T07:50:39Z' }]])],
    ['/auth/v1/admin/users?', route('GET', () => [200, { users: [] }])],
    ['/auth/v1/admin/users', route('POST', () => [200, { id: UID }])]
  ]);
  const r = await call({ accion: 'guardar', origen: 'prestashop', id: 94506, datos: { nombre: 'Giovany Aviles', email: 'MiFiestaShop@gmail.com', telefono: '555', password: 'secreta1', activo: true, newsletter: true, rfc: 'abc123' } });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('ps_clientes?id=eq.94506'));
  assert.equal(patch.body.email, 'mifiestashop@gmail.com'); assert.equal(patch.body.rfc, 'ABC123'); assert.equal(patch.body.newsletter, true);
  const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/auth/v1/admin/users'));
  assert.deepEqual([create.body.email, create.body.password, create.body.email_confirm], ['mifiestashop@gmail.com', 'secreta1', true]);
});

test('cliente-admin: desactivar una cuenta web la bloquea; eliminar la borra', async () => {
  let calls = mock([
    ['/auth/v1/admin/users/' + UID, route('GET', () => [200, { id: UID, email: 'a@b.mx', user_metadata: { full_name: 'Ana' } }])],
    ['/auth/v1/admin/users/' + UID, route('PUT', c => [200, { id: UID, email: c.body.email, user_metadata: c.body.user_metadata, banned_until: '2126-01-01T00:00:00Z', email_confirmed_at: '2026-09-27T00:00:00Z' }])]
  ]);
  let r = await call({ accion: 'guardar', origen: 'web', id: UID, datos: { nombre: 'Ana López', email: 'a@b.mx', activo: false } });
  assert.equal(r.code, 200);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.body.ban_duration, '876000h'); assert.equal(put.body.user_metadata.full_name, 'Ana López');
  assert.equal(r.data.cliente.activo, false);

  calls = mock([['/auth/v1/admin/users/' + UID, route('DELETE', () => [200, {}])]]);
  r = await call({ accion: 'eliminar', origen: 'web', id: UID });
  assert.equal(r.code, 200);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/auth/v1/admin/users/' + UID)));
});

test('cliente-admin: valida origen e id', async () => {
  mock([]);
  assert.equal((await call({ accion: 'obtener', origen: 'web', id: 'no-es-uuid' })).code, 400);
  assert.equal((await call({ accion: 'obtener', origen: 'prestashop', id: 'abc' })).code, 400);
  assert.equal((await call({ accion: 'obtener', origen: 'otro', id: 1 })).code, 400);
});
