const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const handler = require('../api/pedido-admin.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body }, res).then(() => res);
}
const ok = data => ({ ok: true, json: async () => data, text: async () => JSON.stringify(data) });

// Supabase falso: sesión de admin ("buena") o personal Luisa (pin 1234), un pedido en línea con su stock y el historial en memoria.
function fake({ pedido, ledger = [], historialFalla = false } = {}) {
  const st = { pedido: { folio: 'MAN-1', status: 'Pendiente', nota: null, delivery_date: null, tracking_number: null, ...pedido }, ledger: [...ledger], historial: [], deleted: false };
  global.fetch = async (url, opts = {}) => {
    const u = String(url); const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.includes('rpc_check_session')) return ok(body.p_admin_password === 'buena' || body.p_staff_pin === '1234');
    if (u.includes('rpc_check_admin')) return ok(body.p_password === 'buena');
    if (u.includes('rpc_actor_name')) return ok(body.p_admin_password === 'buena' ? 'Administrador' : (body.p_staff_pin === '1234' ? 'Luisa' : null));
    if (u.includes('/rest/v1/pedido_historial')) {
      if (historialFalla) return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      if (opts.method === 'POST') { (Array.isArray(body) ? body : [body]).forEach((r, i) => st.historial.push({ id: st.historial.length + 1, created_at: new Date(2026, 9, 16, 13, st.historial.length).toISOString(), ...r })); return ok(null); }
      const m = u.match(/folio=eq\.([^&]+)/);
      return ok(st.historial.filter(r => r.folio === decodeURIComponent(m[1])).sort((a, b) => b.id - a.id));
    }
    if (u.includes('pos_stock_moves')) {
      if (opts.method === 'POST') { st.ledger.push(...body); return ok(null); }
      return ok(st.ledger.filter(m => u.includes(`folio=eq.${m.folio}`)));
    }
    if (u.includes('pedidos_online')) {
      if (st.deleted) return ok([]);
      if (opts.method === 'PATCH') { Object.assign(st.pedido, body); return ok([st.pedido]); }
      if (opts.method === 'DELETE') { st.deleted = true; return ok([st.pedido]); }
      return ok([st.pedido]);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return st;
}
const ADMIN = { p_admin_password: 'buena' };
const STAFF = { p_admin_password: null, p_staff_email: 'luisa@x.com', p_staff_pin: '1234' };

test('historial: cada cambio de estado anota quién lo hizo (de la sesión, no de lo que mande el navegador)', async () => {
  const st = fake();
  let r = await call({ ...STAFF, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Pago aceptado', registradoPor: 'Otra Persona' });
  assert.equal(r.code, 200); assert.equal(r.data.historialRegistrado, true);
  r = await call({ ...ADMIN, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Enviado' });
  assert.equal(st.historial.length, 2);
  assert.deepEqual([st.historial[0].usuario, st.historial[0].detalle, st.historial[0].accion], ['Luisa', 'Estado: Pendiente → Pago aceptado', 'estado']);
  assert.deepEqual([st.historial[1].usuario, st.historial[1].detalle], ['Administrador', 'Estado: Pago aceptado → Enviado']);
  assert.ok(st.historial.every(h => h.folio === 'MAN-1' && h.origen === 'online'));
});

test('historial: poner el mismo estado no genera movimiento', async () => {
  const st = fake({ pedido: { status: 'Enviado' } });
  await call({ ...ADMIN, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Enviado' });
  assert.equal(st.historial.length, 0);
});

test('historial: cancelar anota las piezas regresadas y una segunda cancelación no repite', async () => {
  const st = fake({ pedido: { status: 'Pago aceptado' }, ledger: [{ id_product: 5, almacen: 'puebla', qty: -4, motivo: 'pedido_manual', folio: 'MAN-1' }] });
  let r = await call({ ...STAFF, accion: 'cancelar', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.data.piezasRegresadas, 4);
  assert.equal(st.historial.length, 1);
  assert.equal(st.historial[0].usuario, 'Luisa');
  assert.match(st.historial[0].detalle, /Pedido cancelado \(estaba en "Pago aceptado"\) · se regresaron 4 piezas al stock/);
  r = await call({ ...STAFF, accion: 'cancelar', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.data.piezasRegresadas, 0);
  assert.equal(st.historial.length, 1, 'la segunda cancelación no cambia nada y no se anota');
});

test('historial: nota, fecha de entrega y guía anotan solo lo que cambió', async () => {
  const st = fake({ pedido: { nota: 'vieja', delivery_date: '2026-10-20', tracking_number: null } });
  await call({ ...ADMIN, accion: 'datos', origen: 'online', folio: 'MAN-1', nota: 'vieja', deliveryDate: '2026-10-25' });
  assert.deepEqual(st.historial.map(h => h.detalle), ['Fecha de entrega: 2026-10-20 → 2026-10-25']);
  await call({ ...STAFF, accion: 'datos', origen: 'online', folio: 'MAN-1', nota: 'nueva nota', trackingNumber: 'EST123' });
  assert.deepEqual(st.historial.slice(1).map(h => h.detalle), ['Nota interna actualizada', 'Guía de rastreo: — → EST123']);
  assert.ok(st.historial.slice(1).every(h => h.usuario === 'Luisa'));
  assert.ok(!st.historial.some(h => /nueva nota/.test(h.detalle)), 'el texto de la nota no se copia al historial');
  const antes = st.historial.length;
  await call({ ...ADMIN, accion: 'datos', origen: 'online', folio: 'MAN-1', nota: 'nueva nota' });
  assert.equal(st.historial.length, antes, 'guardar sin cambios no anota nada');
});

test('historial: borrar un pedido queda anotado', async () => {
  const st = fake({ pedido: { status: 'Pendiente' } });
  const r = await call({ ...ADMIN, accion: 'eliminar', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.code, 200);
  assert.deepEqual([st.historial[0].accion, st.historial[0].usuario], ['eliminar', 'Administrador']);
  assert.match(st.historial[0].detalle, /Pedido borrado \(estaba en "Pendiente"\)/);
});

test('historial: la acción "historial" lista de lo más nuevo a lo más viejo, pide sesión y sirve para cualquier origen', async () => {
  const st = fake();
  await call({ ...ADMIN, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Pago aceptado' });
  await call({ ...ADMIN, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Enviado' });
  let r = await call({ ...STAFF, accion: 'historial', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.data.historial.map(h => h.detalle), ['Estado: Pago aceptado → Enviado', 'Estado: Pendiente → Pago aceptado']);
  assert.ok(r.data.historial[0].created_at && r.data.historial[0].usuario);
  r = await call({ p_admin_password: 'mala', accion: 'historial', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.code, 401);
  r = await call({ ...ADMIN, accion: 'historial', origen: 'prestashop', folio: '123' });
  assert.equal(r.code, 200); assert.deepEqual(r.data.historial, []);
});

test('historial: si no se puede anotar, el cambio se hace igual y se avisa', async () => {
  const st = fake({ historialFalla: true });
  const r = await call({ ...ADMIN, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Enviado' });
  assert.equal(r.code, 200); assert.equal(st.pedido.status, 'Enviado'); assert.equal(r.data.historialRegistrado, false);
});

test('estado "Factura anticipada" es válido, queda en el historial y no cuenta como venta cobrada', async () => {
  const st = fake();
  const r = await call({ ...STAFF, accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Factura anticipada' });
  assert.equal(r.code, 200); assert.equal(st.pedido.status, 'Factura anticipada');
  assert.equal(st.historial[0].detalle, 'Estado: Pendiente → Factura anticipada');
  const ventas = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'ventas.js'), 'utf8');
  assert.match(ventas, /PAGADOS_ONLINE = \[[^\]]*\]/); assert.doesNotMatch(ventas.match(/PAGADOS_ONLINE = \[[^\]]*\]/)[0], /anticipada/i);
});
