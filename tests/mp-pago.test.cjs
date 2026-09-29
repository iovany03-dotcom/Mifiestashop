const test = require('node:test'), assert = require('node:assert/strict');
const { aplicarPago, estadoDesdePago } = require('../lib/mp-pago.js');

// Mercado Pago + Supabase falsos en memoria.
function fake({ pago, pedido }) {
  const st = { pedido: pedido ? { ...pedido } : null, patches: 0 };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    if (u.includes('api.mercadopago.com/v1/payments/')) return pago ? ok(pago) : { ok: false, status: 404, json: async () => ({}) };
    if (u.includes('pedidos_online')) {
      if (opts.method === 'PATCH') { st.patches++; Object.assign(st.pedido, JSON.parse(opts.body)); return ok(null); }
      return ok(st.pedido ? [st.pedido] : []);
    }
    return ok({});
  };
  return st;
}
const args = { accessToken: 'tok', serviceRoleKey: 'srk', paymentId: '123' };

test('mp-pago: estados según el pago', () => {
  assert.equal(estadoDesdePago({ status: 'approved', transaction_amount: 372.95 }, 372.95), 'Pago aceptado');
  assert.equal(estadoDesdePago({ status: 'approved', transaction_amount: 10 }, 372.95), 'Error en el pago');
  assert.equal(estadoDesdePago({ status: 'rejected' }, 100), 'Error en el pago');
  assert.equal(estadoDesdePago({ status: 'in_process' }, 100), 'Pendiente de pago');
  assert.equal(estadoDesdePago({ status: 'refunded' }, 100), 'Reembolsado');
});

test('mp-pago: pago aprobado marca el pedido como Pago aceptado', async () => {
  const st = fake({ pago: { status: 'approved', transaction_amount: 372.95, external_reference: 'WEB-1' }, pedido: { status: 'Pendiente', total: 372.95, items: [] } });
  const r = await aplicarPago(args);
  assert.equal(r.estado, 'Pago aceptado'); assert.equal(st.pedido.status, 'Pago aceptado'); assert.equal(st.pedido.payment_method, 'Mercado Pago');
});

test('mp-pago: pago rechazado -> Error en el pago', async () => {
  const st = fake({ pago: { status: 'rejected', external_reference: 'WEB-1' }, pedido: { status: 'Pendiente', total: 100 } });
  const r = await aplicarPago(args);
  assert.equal(r.estado, 'Error en el pago'); assert.equal(st.pedido.status, 'Error en el pago');
});

test('mp-pago: guarda el motivo del rechazo (status_detail)', async () => {
  const st = fake({ pago: { id: 9, status: 'rejected', status_detail: 'cc_rejected_insufficient_amount', external_reference: 'WEB-1' }, pedido: { status: 'Pendiente', total: 100 } });
  const r = await aplicarPago(args);
  assert.equal(st.pedido.mp_status_detail, 'cc_rejected_insufficient_amount');
  assert.equal(r.mpStatusDetail, 'cc_rejected_insufficient_amount');
});

test('mp-pago: una notificación de un intento fallido no baja un pedido ya pagado', async () => {
  const st = fake({ pago: { status: 'rejected', external_reference: 'WEB-1' }, pedido: { status: 'Pago aceptado', total: 100 } });
  const r = await aplicarPago(args);
  assert.equal(r.estado, 'Pago aceptado'); assert.equal(st.patches, 0);
});

test('mp-pago: no toca pedidos que el personal ya movió (Enviado)', async () => {
  const st = fake({ pago: { status: 'approved', transaction_amount: 100, external_reference: 'WEB-1' }, pedido: { status: 'Enviado', total: 100 } });
  const r = await aplicarPago(args);
  assert.equal(r.estado, 'Enviado'); assert.equal(st.pedido.status, 'Enviado'); assert.equal(st.pedido.mp_status, 'approved');
});

test('mp-pago: el pago debe ser del mismo pedido', async () => {
  fake({ pago: { status: 'approved', transaction_amount: 100, external_reference: 'WEB-2' }, pedido: { status: 'Pendiente', total: 100 } });
  assert.equal(await aplicarPago({ ...args, folioEsperado: 'WEB-1' }), null);
});

test('mp-confirmar: valida datos y responde el estado', async () => {
  process.env.MP_ACCESS_TOKEN = 'tok'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  const handler = require('../api/mp-confirmar.js');
  const call = body => { const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } }; return handler({ method: 'POST', body }, res).then(() => res); };
  let r = await call({ folio: 'WEB-1', paymentId: 'abc' });
  assert.equal(r.code, 400);
  fake({ pago: { status: 'approved', transaction_amount: 50, external_reference: 'WEB-1' }, pedido: { status: 'Pendiente', total: 50 } });
  r = await call({ folio: 'WEB-1', paymentId: '999' });
  assert.equal(r.code, 200); assert.equal(r.data.estado, 'Pago aceptado');
});
