// Foto de la reseña del cliente por venta (api/resenas-venta.js).
const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
const sesion = require('../lib/sesion-panel.js');
const handler = require('../api/resenas-venta.js');
const res = () => { const r = { code: 0, data: null, setHeader() {}, status(c) { r.code = c; return r; }, json(d) { r.data = d; return r; } }; return r; };

function mock({ nombre = 'Ana', admin = false, existente = null }) {
  const ll = [];
  sesion.sesionPanel = async () => ({ nombre, es_admin: admin, permisos: [] });
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url)); ll.push({ u, opts });
    const ok = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('/personal_equipo')) return ok([{ id: 7, nombre }]);
    if (u.includes('/resenas_venta?select=path')) return ok(existente ? [existente] : []);
    if (u.includes('/resenas_venta?select=folio')) return ok([{ folio: '#POS-1', path: 'p.jpg', subido_por: 'Ana', creado_at: 'x' }]);
    if (u.includes('/storage/v1/object/sign/')) return ok([{ path: 'p.jpg', signedURL: '/object/sign/resenas-venta/p.jpg?token=t' }]);
    return ok(null);
  };
  return ll;
}
const creds = { p_staff_email: 'ana@x.mx', p_staff_pin: '1' };
const FOTO = { media_type: 'image/jpeg', data: Buffer.from('jpg').toString('base64') };

test('subir: guarda la foto ligada al folio y a quien la subió', async () => {
  const ll = mock({});
  const r = res();
  await handler({ method: 'POST', body: { accion: 'subir', creds, folio: '#POS-21254', sucursal: 'Puebla', archivo: FOTO } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.ok(ll.some(c => c.u.includes('/storage/v1/object/resenas-venta/') && c.u.includes('POS-21254-')));
  const alta = ll.find(c => c.u.includes('/resenas_venta?on_conflict=folio'));
  const fila = JSON.parse(alta.opts.body)[0];
  assert.equal(fila.folio, '#POS-21254'); assert.equal(fila.subido_por, 'Ana'); assert.equal(fila.empleado_id, 7); assert.equal(fila.sucursal, 'Puebla');
});

test('subir: folio raro o sin foto -> 400', async () => {
  mock({});
  let r = res(); await handler({ method: 'POST', body: { accion: 'subir', creds, folio: 'a"); drop', archivo: FOTO } }, r);
  assert.equal(r.code, 400);
  r = res(); await handler({ method: 'POST', body: { accion: 'subir', creds, folio: '#POS-1', archivo: { media_type: 'application/pdf', data: 'x' } } }, r);
  assert.equal(r.code, 400);
});

test('listar: devuelve la liga firmada por folio', async () => {
  mock({});
  const r = res(); await handler({ method: 'POST', body: { accion: 'listar', creds, folios: ['#POS-1', '#POS-2'] } }, r);
  assert.equal(r.code, 200);
  assert.match(r.data.resenas['#POS-1'].url, /storage\/v1\/object\/sign\/resenas-venta\/p\.jpg\?token=t/);
  assert.equal(r.data.resenas['#POS-2'], undefined);
});

test('quitar: solo quien la subió o el administrador', async () => {
  mock({ nombre: 'Luis', existente: { path: 'p.jpg', subido_por: 'Ana' } });
  let r = res(); await handler({ method: 'POST', body: { accion: 'quitar', creds, folio: '#POS-1' } }, r);
  assert.equal(r.code, 403);
  mock({ nombre: 'Administrador', admin: true, existente: { path: 'p.jpg', subido_por: 'Ana' } });
  r = res(); await handler({ method: 'POST', body: { accion: 'quitar', creds: { p_admin_password: 'x' }, folio: '#POS-1' } }, r);
  assert.equal(r.code, 200);
});
