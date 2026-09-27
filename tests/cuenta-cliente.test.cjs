const test = require('node:test'), assert = require('node:assert/strict');

// Se reemplaza el envío real (nodemailer) antes de cargar el endpoint.
const correo = require('../lib/correo.js');
const sent = [];
let failSend = false;
correo.sendTemplate = async (to, tipo, datos) => { if (failSend) throw new Error('smtp caído'); sent.push({ to, tipo, datos }); };
correo.smtpConfigured = () => true;
const handler = require('../api/cuenta-cliente.js');

process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

function call(body, host = 'mifiestashop.vercel.app') {
  const res = { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body, headers: { host } }, res).then(() => res);
}
function mockSupabase(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [pattern, reply] of routes) if (u.includes(pattern)) return reply(opts);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return calls;
}
const reply = (status, data) => () => ({ ok: status < 400, status, json: async () => data });

test('registro: crea el usuario con generate_link y manda el correo de Mi Fiestashop a nuestro dominio', async () => {
  sent.length = 0; failSend = false;
  const calls = mockSupabase([['/auth/v1/admin/generate_link', reply(200, { id: 'u-1', hashed_token: 'abc123', action_link: 'https://x.supabase.co/auth/v1/verify?token=abc' })]]);
  const r = await call({ accion: 'registro', nombre: 'Ana', email: 'Ana@Test.mx ', telefono: '555', password: 'secreta1' });
  assert.equal(r.code, 200); assert.deepEqual(r.data, { ok: true, userId: 'u-1' });
  const gl = calls.find(c => c.url.includes('generate_link'));
  assert.deepEqual(gl.body, { type: 'signup', email: 'ana@test.mx', password: 'secreta1', data: { full_name: 'Ana', phone: '555' }, redirect_to: 'https://mifiestashop.vercel.app' });
  assert.equal(gl.opts.headers.Authorization, 'Bearer service-role-test');
  assert.deepEqual(sent, [{ to: 'ana@test.mx', tipo: 'confirmacion', datos: { nombre: 'Ana', confirmUrl: 'https://mifiestashop.vercel.app/?confirmar=abc123' } }]);
});

test('registro: un Host ajeno no se usa en el enlace del correo', async () => {
  sent.length = 0; failSend = false;
  mockSupabase([['/auth/v1/admin/generate_link', reply(200, { id: 'u-2', hashed_token: 'tok' })]]);
  await call({ accion: 'registro', nombre: 'Ana', email: 'a@b.mx', password: 'secreta1' }, 'evil.example.com');
  assert.equal(sent[0].datos.confirmUrl, 'https://mifiestashop.vercel.app/?confirmar=tok');
});

test('registro: correo ya registrado responde 409 sin mandar correo', async () => {
  sent.length = 0; failSend = false;
  mockSupabase([['/auth/v1/admin/generate_link', reply(422, { msg: 'A user with this email address has already been registered' })]]);
  const r = await call({ accion: 'registro', nombre: 'Ana', email: 'a@b.mx', password: 'secreta1' });
  assert.equal(r.code, 409); assert.match(r.data.error, /Ya existe una cuenta/); assert.equal(sent.length, 0);
});

test('registro: si el correo no sale, se borra el usuario para poder reintentar', async () => {
  sent.length = 0; failSend = true;
  const calls = mockSupabase([['/auth/v1/admin/generate_link', reply(200, { id: 'u-3', hashed_token: 'tok' })], ['/auth/v1/admin/users/u-3', reply(200, {})]]);
  const r = await call({ accion: 'registro', nombre: 'Ana', email: 'a@b.mx', password: 'secreta1' });
  assert.equal(r.code, 502);
  assert.ok(calls.some(c => c.url.endsWith('/auth/v1/admin/users/u-3') && c.opts.method === 'DELETE'));
  failSend = false;
});

test('registro: valida nombre y contraseña', async () => {
  mockSupabase([]);
  assert.equal((await call({ accion: 'registro', nombre: '', email: 'a@b.mx', password: 'secreta1' })).code, 400);
  assert.equal((await call({ accion: 'registro', nombre: 'Ana', email: 'a@b.mx', password: '123' })).code, 400);
  assert.equal((await call({ accion: 'registro', nombre: 'Ana', email: 'no-es-correo', password: 'secreta1' })).code, 400);
});

test('recuperar: manda el correo si la cuenta existe y responde igual si no existe', async () => {
  sent.length = 0; failSend = false;
  mockSupabase([['/auth/v1/admin/generate_link', reply(200, { id: 'u-4', hashed_token: 'rec1', user_metadata: { full_name: 'Ana' } })]]);
  let r = await call({ accion: 'recuperar', email: 'a@b.mx' });
  assert.equal(r.code, 200);
  assert.deepEqual(sent, [{ to: 'a@b.mx', tipo: 'recuperacion', datos: { nombre: 'Ana', resetUrl: 'https://mifiestashop.vercel.app/?recuperar=rec1' } }]);

  sent.length = 0;
  mockSupabase([['/auth/v1/admin/generate_link', reply(404, { msg: 'User not found' })]]);
  r = await call({ accion: 'recuperar', email: 'nadie@b.mx' });
  assert.equal(r.code, 200); assert.deepEqual(r.data, { ok: true }); assert.equal(sent.length, 0);
});
