const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const handler = require('../api/pedido-admin.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body }, res).then(() => res);
}
const ok = (data) => ({ ok: true, json: async () => data, text: async () => JSON.stringify(data) });

// Supabase falso: sesión de admin ("buena") o personal ("staff"), un pedido
// y su ledger de stock en memoria.
function fakeSupabase({ ledger = [], pedido = { folio: 'MAN-1', status: 'Pendiente' } } = {}) {
  const state = { ledger: [...ledger], pedido: { ...pedido }, deleted: false, urls: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url); state.urls.push(`${opts.method || 'GET'} ${u}`);
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.includes('rpc_check_session')) return ok(['buena', null].includes(body.p_admin_password) && (body.p_admin_password || body.p_staff_pin === '1234'));
    if (u.includes('rpc_check_admin')) return ok(body.p_password === 'buena');
    if (u.includes('pos_stock_moves')) {
      if (opts.method === 'POST') { state.ledger.push(...body); return ok(null); }
      return ok(state.ledger.filter(m => u.includes(`folio=eq.${m.folio}`)));
    }
    if (u.includes('pedidos_online') || u.includes('pos_tickets')) {
      if (state.deleted || !u.includes(`folio=eq.${state.pedido.folio}`)) return ok([]);
      if (opts.method === 'PATCH') { Object.assign(state.pedido, body); return ok([state.pedido]); }
      if (opts.method === 'DELETE') { state.deleted = true; return ok([state.pedido]); }
    }
    return { ok: false, json: async () => ({}), text: async () => '' };
  };
  return state;
}

test('pedido-admin: sin sesión no toca nada', async () => {
  const st = fakeSupabase();
  const r = await call({ p_admin_password: 'mala', accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Enviado' });
  assert.equal(r.code, 401);
  assert.ok(st.urls.every(u => !u.includes('pedidos_online')));
});

test('pedido-admin: los pedidos de PrestaShop se cambian en PrestaShop', async () => {
  fakeSupabase();
  const r = await call({ p_admin_password: 'buena', accion: 'estado', origen: 'prestashop', folio: '123', estado: 'Enviado' });
  assert.equal(r.code, 409);
});

test('pedido-admin: cambiar estado se guarda y valida el estado', async () => {
  const st = fakeSupabase();
  let r = await call({ p_admin_password: 'buena', accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Inventado' });
  assert.equal(r.code, 400);
  r = await call({ p_admin_password: 'buena', accion: 'estado', origen: 'online', folio: 'MAN-1', estado: 'Enviado' });
  assert.equal(r.code, 200); assert.equal(st.pedido.status, 'Enviado'); assert.equal(r.data.piezasRegresadas, 0);
  r = await call({ p_admin_password: 'buena', accion: 'estado', origen: 'online', folio: 'NO-EXISTE', estado: 'Enviado' });
  assert.equal(r.code, 404);
});

test('pedido-admin: cancelar regresa el stock una sola vez', async () => {
  const st = fakeSupabase({
    pedido: { folio: 'T-9', estado: null },
    ledger: [
      { id_product: 10, almacen: 'puebla', qty: -3, folio: 'T-9' },
      { id_product: 11, almacen: 'puebla', qty: -2, folio: 'T-9' },
      { id_product: 10, almacen: 'rumania', qty: -5, folio: 'OTRO' }
    ]
  });
  let r = await call({ p_staff_email: 'caja@x.mx', p_staff_pin: '1234', accion: 'cancelar', origen: 'pos', folio: 'T-9', registradoPor: 'Caja' });
  assert.equal(r.code, 200); assert.equal(r.data.piezasRegresadas, 5); assert.equal(st.pedido.estado, 'Cancelado');
  const rev = st.ledger.filter(m => m.motivo === 'cancelacion');
  assert.deepEqual(rev.map(m => [m.id_product, m.almacen, m.qty]).sort(), [[10, 'puebla', 3], [11, 'puebla', 2]]);
  r = await call({ p_staff_email: 'caja@x.mx', p_staff_pin: '1234', accion: 'cancelar', origen: 'pos', folio: 'T-9' });
  assert.equal(r.code, 200); assert.equal(r.data.piezasRegresadas, 0);
  assert.equal(st.ledger.filter(m => m.motivo === 'cancelacion').length, 2);
});

test('pedido-admin: borrar solo lo hace el super administrador', async () => {
  const st = fakeSupabase({ ledger: [{ id_product: 7, almacen: 'rumania', qty: -4, folio: 'MAN-1' }] });
  let r = await call({ p_staff_email: 'caja@x.mx', p_staff_pin: '1234', accion: 'eliminar', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.code, 403); assert.equal(st.deleted, false);
  r = await call({ p_admin_password: 'buena', accion: 'eliminar', origen: 'online', folio: 'MAN-1' });
  assert.equal(r.code, 200); assert.equal(st.deleted, true); assert.equal(r.data.piezasRegresadas, 4);
});

test('pedido-admin: guarda nota, fecha de entrega y guía de pedidos en línea', async () => {
  const st = fakeSupabase();
  let r = await call({ p_admin_password: 'buena', accion: 'datos', origen: 'online', folio: 'MAN-1', nota: 'Entregar en recepción', deliveryDate: '2026-10-01', trackingNumber: 'FDX123' });
  assert.equal(r.code, 200);
  assert.equal(st.pedido.nota, 'Entregar en recepción'); assert.equal(st.pedido.delivery_date, '2026-10-01'); assert.equal(st.pedido.tracking_number, 'FDX123');
  r = await call({ p_admin_password: 'buena', accion: 'datos', origen: 'online', folio: 'MAN-1', deliveryDate: '1/10/2026' });
  assert.equal(r.code, 400);
  r = await call({ p_admin_password: 'buena', accion: 'datos', origen: 'pos', folio: 'MAN-1', nota: 'x' });
  assert.equal(r.code, 400);
});
