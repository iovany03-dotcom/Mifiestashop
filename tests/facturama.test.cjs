const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.FACTURAMA_USER = 'usr'; process.env.FACTURAMA_PASSWORD = 'pwd'; process.env.FACTURAMA_EXPEDITION_PLACE = '72000';
const handler = require('../api/facturama.js');
const fx = require('../lib/facturama.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body: { p_admin_password: 'buena', ...body } }, res).then(() => res);
}
const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const PEDIDOS = {
  'WEB-1': { folio: 'WEB-1', status: 'Pago aceptado', total: 116, subtotal: 116, shipping_cost: 0, customer_email: 'c@x.com', customer_name: 'Ana', items: [{ id: 83591, name: 'Globo', sku: 'G1', qty: 2, price: 58 }] },
  'WEB-2': { folio: 'WEB-2', status: 'Pendiente', total: 116, items: [{ id: 1, name: 'Globo', qty: 2, price: 58 }] },
  'WEB-3': { folio: 'WEB-3', status: 'Entregado', subtotal: 1000, discount_amount: 100, shipping_cost: 150, shipping_carrier: 'Estafeta', total: 1050,
             items: [{ id: 1, name: 'Promo Boda', sku: 'Boda, promo, VIP', qty: 1, price: 800 }, { id: 2, name: 'Mandil', sku: 'MAN', qty: 10, price: 20 }] }
};
const TICKETS = {
  '#POS-123': { folio: '#POS-123', total: 73, items: [{ product_id: '10790803185325', name: 'Globo calabaza', sku: 'Globo, metalico', qty: 1, price: 24 }, { product_id: '5', name: 'Vela', qty: 7, price: 7 }] },
  '#POS-999': { folio: '#POS-999', total: 50, estado: 'cancelada', items: [{ product_id: '1', name: 'Vela', qty: 1, price: 50 }] }
};
function fake({ facturas = [], timbre } = {}) {
  const st = { cfdi: null, facturas: [...facturas], calls: [], auth: null };
  global.fetch = async (url, opts = {}) => {
    const u = String(url); st.calls.push(`${opts.method || 'GET'} ${u}`);
    if (u.includes('rpc_check_session')) return ok(JSON.parse(opts.body).p_admin_password === 'buena');
    if (u.includes('facturama.mx')) {
      st.auth = opts.headers.Authorization;
      if (u.endsWith('/3/cfdis')) {
        st.cfdi = JSON.parse(opts.body);
        if (timbre) return timbre;
        return ok({ Id: 'ABC12345', Folio: st.cfdi.Folio, Total: 116, Complement: { TaxStamp: { Uuid: 'UUID-1' } } });
      }
      if (u.includes('/cfdi/pdf/')) return ok({ Content: 'JVBER' });
      if (u.includes('DELETE') || opts.method === 'DELETE') return ok({ Status: 'canceled', Message: 'Cancelado' });
      return ok({ success: true });
    }
    const mFolio = u.match(/folio=eq\.([^&]+)/);
    if (u.includes('/rest/v1/pedidos_online')) { const p = PEDIDOS[decodeURIComponent(mFolio[1])]; return ok(p ? [p] : []); }
    if (u.includes('/rest/v1/pos_tickets')) { const t = TICKETS[decodeURIComponent(mFolio[1])]; return ok(t ? [t] : []); }
    if (u.includes('/rest/v1/facturas')) {
      if (opts.method === 'POST') { const b = JSON.parse(opts.body); st.facturas.push(...b); return ok(b); }
      if (opts.method === 'PATCH') return ok(null);
      return ok(st.facturas);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return st;
}
const receptor = { rfc: 'URE180429TM6', nombre: 'Universidad Robotica Española', cp: '86991', regimen: '601', usoCfdi: 'G03' };

test('facturama: sin sesión no emite', async () => {
  fake();
  const r = await call({ p_admin_password: 'mala', accion: 'emitir' });
  assert.equal(r.code, 401);
});

test('facturama: emite con IVA incluido, auth Basic y sandbox por defecto', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', origen: 'online', pedidoFolio: 'WEB-1', receptor, formaPago: '03' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(st.auth, 'Basic ' + Buffer.from('usr:pwd').toString('base64'));
  assert.ok(st.calls.some(c => c.startsWith('POST https://apisandbox.facturama.mx/3/cfdis')));
  const it = st.cfdi.Items[0];
  assert.equal(it.Subtotal, 100); assert.equal(it.Taxes[0].Total, 16); assert.equal(it.Total, 116);
  assert.equal(st.cfdi.Receiver.Name, 'UNIVERSIDAD ROBOTICA ESPAÑOLA');
  assert.equal(st.cfdi.ExpeditionPlace, '72000'); assert.equal(st.cfdi.PaymentForm, '03');
  assert.equal(r.data.factura.uuid, 'UUID-1'); assert.equal(st.facturas[0].pedido_folio, 'WEB-1');
});

test('facturama: no duplica la factura de un pedido ya facturado', async () => {
  const st = fake({ facturas: [{ pedido_folio: 'WEB-1', uuid: 'U', entorno: 'sandbox', estado: 'activa' }] });
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-1', receptor });
  assert.equal(r.code, 409); assert.equal(st.cfdi, null);
});

test('facturama: valida receptor y no llama a Facturama', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-1', receptor: { ...receptor, rfc: 'MAL' } });
  assert.equal(r.code, 400); assert.match(r.data.error, /RFC/); assert.equal(st.cfdi, null);
});

test('facturama: error de Facturama se devuelve legible y no guarda nada', async () => {
  const st = fake({ timbre: { ok: false, status: 400, text: async () => JSON.stringify({ Message: 'Régimen no válido' }) } });
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-1', receptor });
  assert.equal(r.code, 422); assert.match(r.data.error, /Régimen no válido/); assert.equal(st.facturas.length, 0);
});

test('facturama: cancelar valida motivo 01 y marca la factura', async () => {
  fake();
  assert.equal((await call({ accion: 'cancelar', id: 'ABC12345', motivo: '01' })).code, 400);
  const r = await call({ accion: 'cancelar', id: 'ABC12345', motivo: '02' });
  assert.equal(r.code, 200); assert.equal(r.data.estado, 'cancelada');
});

test('facturama: descargar pdf y producción solo con FACTURAMA_ENV', async () => {
  fake();
  assert.equal((await call({ accion: 'descargar', id: 'ABC12345', formato: 'pdf' })).data.content, 'JVBER');
  assert.equal(fx.entorno(), 'sandbox');
  process.env.FACTURAMA_ENV = 'production';
  const st = fake();
  await call({ accion: 'emitir', pedidoFolio: 'WEB-1', receptor });
  assert.ok(st.calls.some(c => c.includes('https://api.facturama.mx/3/cfdis')));
  delete process.env.FACTURAMA_ENV;
});

test('facturama: sin pedido o ticket no se puede facturar', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', receptor, items: [{ name: 'X', qty: 1, price: 10 }] });
  assert.equal(r.code, 400); assert.match(r.data.error, /vincular la factura a un pedido/); assert.equal(st.cfdi, null);
  const r2 = await call({ accion: 'emitir', origen: 'manual', pedidoFolio: '', receptor });
  assert.equal(r2.code, 400);
  const r3 = await call({ accion: 'emitir', pedidoFolio: 'WEB-404', receptor });
  assert.equal(r3.code, 404); assert.match(r3.data.error, /No existe el pedido WEB-404/); assert.equal(st.cfdi, null);
});

test('facturama: solo pedidos pagados y tickets no cancelados', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-2', receptor });
  assert.equal(r.code, 409); assert.match(r.data.error, /"Pendiente": solo se facturan pedidos pagados/);
  const r2 = await call({ accion: 'emitir', origen: 'pos', pedidoFolio: '#POS-999', receptor });
  assert.equal(r2.code, 409); assert.match(r2.data.error, /cancelado/);
  assert.equal(st.cfdi, null);
});

test('facturama: los conceptos salen del pedido, no de lo que mande el navegador', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-1', receptor, items: [{ name: 'Otra cosa', qty: 1, price: 99999 }] });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(st.cfdi.Items.length, 1);
  assert.equal(st.cfdi.Items[0].Description, 'Globo'); assert.equal(st.cfdi.Items[0].Total, 116);
  assert.equal(st.cfdi.OrderNumber, 'WEB-1');
});

test('facturama: pedido con cupón y envío -> descuento repartido y envío como servicio, total igual al pedido', async () => {
  const st = fake();
  const p = await call({ accion: 'pedido', folio: 'web-3' });
  assert.equal(p.code, 200, JSON.stringify(p.data));
  assert.equal(p.data.pedido.facturable, true, p.data.pedido.motivo);
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-3', receptor });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  const items = st.cfdi.Items;
  assert.equal(items.length, 3);
  assert.equal(items[0].IdentificationNumber, '1'); // el "SKU" de palabras clave se cambia por el id
  assert.ok(items[0].Discount > 0 && items[1].Discount > 0);
  const envio = items[2];
  assert.equal(envio.ProductCode, '78102203'); assert.equal(envio.UnitCode, 'E48'); assert.match(envio.Description, /Envío \(Estafeta\)/);
  const total = items.reduce((s, c) => s + c.Total, 0);
  assert.ok(Math.abs(total - 1050) <= 0.05, `total ${total}`);
  for (const c of items) assert.ok(Math.abs(c.Subtotal - (c.Discount || 0) - c.Taxes[0].Base) < 0.001);
});

test('facturama: ticket del POS con folio escrito sin # se encuentra', async () => {
  const st = fake();
  const p = await call({ accion: 'pedido', folio: 'pos-123' });
  assert.equal(p.code, 200, JSON.stringify(p.data));
  assert.equal(p.data.pedido.origen, 'pos'); assert.equal(p.data.pedido.folio, '#POS-123');
  const r = await call({ accion: 'emitir', origen: 'pos', pedidoFolio: 'POS-123', receptor });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(st.facturas[0].pedido_folio, '#POS-123'); assert.equal(st.facturas[0].origen, 'pos');
  assert.equal(st.cfdi.Items[0].IdentificationNumber, '10790803185325');
});
