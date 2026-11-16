// Fotos de tienda para la comisión (lib/fotos-comision.js + api/fotos-comision.js).
const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
const cal = require('../lib/fotos-comision.js');

test('calendario: aviso un día antes del pago; si el 15 es domingo, pago sábado y aviso viernes', () => {
  assert.deepEqual(cal.calendarioDe('2026-12-15'), { periodo: '2026-12-15', pago: '2026-12-15', aviso: '2026-12-14' }); // martes
  assert.deepEqual(cal.calendarioDe('2026-11-15'), { periodo: '2026-11-15', pago: '2026-11-14', aviso: '2026-11-13' }); // domingo
  assert.deepEqual(cal.calendarioDe('2026-08-15'), { periodo: '2026-08-15', pago: '2026-08-15', aviso: '2026-08-14' }); // sábado: se paga el sábado
  assert.deepEqual(cal.calendarioDe('2027-03-15'), { periodo: '2027-03-15', pago: '2027-03-15', aviso: '2027-03-14' }); // lunes: aviso domingo 14
});

test('fin de mes: 31 -> aviso 30; 30 -> aviso 29; febrero en su último día; domingo -> sábado y viernes', () => {
  assert.deepEqual(cal.calendarioDe('2026-12-31'), { periodo: '2026-12-31', pago: '2026-12-31', aviso: '2026-12-30' }); // jueves
  assert.equal(cal.ventanaAbierta('2026-11-29').periodo, '2026-11-30');   // lunes 30
  assert.equal(cal.ventanaAbierta('2026-11-28'), null);
  assert.equal(cal.ventanaAbierta('2027-02-27').periodo, '2027-02-28');   // domingo 28 -> pago sábado 27
  assert.deepEqual(cal.calendarioDe('2027-02-28'), { periodo: '2027-02-28', pago: '2027-02-27', aviso: '2027-02-26' });
  assert.deepEqual(cal.calendarioDe('2027-01-31'), { periodo: '2027-01-31', pago: '2027-01-30', aviso: '2027-01-29' }); // domingo 31
  assert.equal(cal.ventanaAbierta('2027-01-29').periodo, '2027-01-31');
  assert.equal(cal.proxima('2026-11-16').periodo, '2026-11-30');
});

test('ventana: abierta del aviso al pago, cerrada el resto del mes', () => {
  assert.equal(cal.ventanaAbierta('2026-12-13'), null);
  assert.equal(cal.ventanaAbierta('2026-12-14').periodo, '2026-12-15');
  assert.equal(cal.ventanaAbierta('2026-12-15').periodo, '2026-12-15');
  assert.equal(cal.ventanaAbierta('2026-12-16'), null);
  assert.equal(cal.ventanaAbierta('2026-11-13').pago, '2026-11-14');
  assert.equal(cal.ventanaAbierta('2026-11-15'), null, 'el domingo ya pasó el pago');
  assert.equal(cal.proxima('2026-12-20').periodo, '2026-12-31');
  assert.equal(cal.proxima('2027-01-01').periodo, '2027-01-15');
});

test('hora de CDMX: a las 11 pm del 13 en CDMX (5 am UTC del 14) sigue siendo 13', () => {
  assert.equal(cal.hoyMx(new Date('2026-12-14T05:00:00Z')), '2026-12-13');
  assert.equal(cal.hoyMx(new Date('2026-12-14T07:00:00Z')), '2026-12-14');
});

test('sucursal ligada en Personal / Equipo', () => {
  assert.equal(cal.sucursalDeBodega('CDMX Rumania'), 'rumania');
  assert.equal(cal.sucursalDeBodega('Querétaro'), 'queretaro');
  assert.equal(cal.sucursalDeBodega('Puebla'), 'puebla');
  assert.equal(cal.sucursalDeBodega('Todas'), null);
});

function mock({ hoy, empleado, registros = [] }) {
  const llamadas = [];
  const sesion = require('../lib/sesion-panel.js');
  sesion.sesionPanel = async () => ({ nombre: empleado ? empleado.nombre : 'Administrador', es_admin: !empleado, permisos: [] });
  cal.hoyMx = () => hoy;
  global.fetch = async (url, opts = {}) => {
    const u = String(url); llamadas.push({ u, opts });
    const ok = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('/personal_equipo')) return ok(empleado ? [empleado] : []);
    if (u.includes('/fotos_comision') && (!opts.method || opts.method === 'GET')) return ok(registros);
    if (u.includes('/storage/v1/object/sign/')) return ok([]);
    return ok(null);
  };
  return llamadas;
}
const res = () => { const r = { code: 0, data: null, setHeader() {}, status(c) { r.code = c; return r; }, json(d) { r.data = d; return r; } }; return r; };
const handler = () => { delete require.cache[require.resolve('../api/fotos-comision.js')]; return require('../api/fotos-comision.js'); };
const creds = { p_staff_email: 'ana@x.mx', p_staff_pin: '1234' };
const FOTO = { media_type: 'image/jpeg', data: Buffer.from('jpg').toString('base64') };

test('subir: con la ventana abierta se guarda con la sucursal ligada a la persona', async () => {
  const ll = mock({ hoy: '2026-12-14', empleado: { id: 7, nombre: 'Ana', bodega_asignada: 'Puebla' } });
  const r = res();
  await handler()({ method: 'POST', body: { accion: 'subir', creds, sucursal: 'rumania', archivo: FOTO } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { ok: true, periodo: '2026-12-15', sucursal: 'puebla' }, 'la sucursal ligada manda sobre la elegida');
  assert.ok(ll.some(c => c.u.includes('/storage/v1/object/fotos-comision/2026-12-15/puebla/7-')));
  const alta = ll.find(c => c.u.endsWith('/rest/v1/fotos_comision') && c.opts.method === 'POST');
  assert.equal(JSON.parse(alta.opts.body).sucursal, 'puebla');
});

test('subir: fuera de la ventana no deja; con "Todas" pide elegir sucursal; el admin no sube', async () => {
  mock({ hoy: '2026-12-10', empleado: { id: 7, nombre: 'Ana', bodega_asignada: 'Puebla' } });
  let r = res(); await handler()({ method: 'POST', body: { accion: 'subir', creds, archivo: FOTO } }, r);
  assert.equal(r.code, 400); assert.match(r.data.error, /no está abierta/);
  mock({ hoy: '2026-12-14', empleado: { id: 8, nombre: 'Lu', bodega_asignada: 'Todas' } });
  r = res(); await handler()({ method: 'POST', body: { accion: 'subir', creds, archivo: FOTO } }, r);
  assert.equal(r.code, 400); assert.match(r.data.error, /Elige la sucursal/);
  mock({ hoy: '2026-12-14', empleado: null });
  r = res(); await handler()({ method: 'POST', body: { accion: 'subir', creds: { p_admin_password: 'x' }, archivo: FOTO } }, r);
  assert.equal(r.code, 403);
});

test('historial: solo admin o quien tiene el permiso fotos-comision', async () => {
  mock({ hoy: '2026-12-14', empleado: { id: 7, nombre: 'Ana', bodega_asignada: 'Puebla' } });
  let r = res(); await handler()({ method: 'POST', body: { accion: 'historial', creds } }, r);
  assert.equal(r.code, 403);
  mock({ hoy: '2026-12-14', empleado: null, registros: [{ id: 1, periodo: '2026-12-15', empleado: 'Ana', sucursal: 'puebla', archivos: [{ path: 'a.jpg' }], estado: 'enviado' }] });
  r = res(); await handler()({ method: 'POST', body: { accion: 'historial', creds: { p_admin_password: 'x' } } }, r);
  assert.equal(r.code, 200); assert.equal(r.data.filas.length, 1);
});
