// Check-in en HR PRO obligatorio para el panel (api/hr-checkin.js).
const test = require('node:test'), assert = require('node:assert/strict');
process.env.HR_CHECKIN_KEY = 'hrck_prueba';
process.env.HR_BASE_URL = 'https://hr.ejemplo';
const handler = require('../api/hr-checkin.js');

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const req = (body) => ({ method: 'POST', headers: {}, body });
const staff = { p_admin_password: null, p_staff_email: 'Wendy@Ejemplo.com', p_staff_pin: '1234' };

test('el administrador (contraseña de admin) nunca se bloquea y no consulta a HR', async () => {
  handler.sesionPanel = async () => ({ nombre: 'Admin', es_admin: true });
  let llamado = false;
  global.fetch = async () => { llamado = true; return { ok: true, json: async () => ({}) }; };
  const r = res();
  await handler(req({ accion: 'estado', creds: { p_admin_password: 'x' } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.required, false);
  assert.equal(llamado, false);
});

test('personal: consulta a HR con su correo (en minúsculas) y la llave del sistema', async () => {
  handler.sesionPanel = async () => ({ nombre: 'Wendy', es_admin: false });
  let visto;
  global.fetch = async (url, opts) => { visto = { url: String(url), key: opts.headers['x-api-key'] }; return { ok: true, json: async () => ({ ok: true, required: true, checkedIn: false }) }; };
  const r = res();
  await handler(req({ accion: 'estado', creds: staff }), r);
  assert.equal(r.body.required, true);
  assert.equal(visto.url, 'https://hr.ejemplo/api/integrations/checkin?email=wendy%40ejemplo.com');
  assert.equal(visto.key, 'hrck_prueba');
});

test('si HR no responde, no se bloquea a nadie', async () => {
  handler.sesionPanel = async () => ({ nombre: 'Wendy', es_admin: false });
  global.fetch = async () => { throw new Error('caído'); };
  const r = res();
  await handler(req({ accion: 'estado', creds: staff }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.required, false);
});

test('checkin: manda la ubicación a HR y regresa su error (fuera de la geocerca)', async () => {
  handler.sesionPanel = async () => ({ nombre: 'Wendy', es_admin: false });
  let enviado;
  global.fetch = async (url, opts) => { enviado = JSON.parse(opts.body); return { ok: false, status: 422, json: async () => ({ ok: false, error: 'Estás a 900 m' }) }; };
  const r = res();
  await handler(req({ accion: 'checkin', creds: staff, latitude: 19.4, longitude: -99.1 }), r);
  assert.deepEqual(enviado, { email: 'wendy@ejemplo.com', latitude: 19.4, longitude: -99.1 });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'Estás a 900 m');
});

test('sin sesión válida responde el error de sesión', async () => {
  handler.sesionPanel = async () => { const e = new Error('Inicia sesión en el panel.'); e.status = 401; throw e; };
  const r = res();
  await handler(req({ accion: 'estado', creds: {} }), r);
  assert.equal(r.statusCode, 401);
});
