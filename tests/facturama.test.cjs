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
  const r = await call({ accion: 'emitir', origen: 'online', pedidoFolio: 'WEB-1', receptor, formaPago: '03', items: [{ name: 'Globo', sku: 'G1', qty: 2, price: 58 }] });
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
  const r = await call({ accion: 'emitir', pedidoFolio: 'WEB-1', receptor, items: [{ name: 'Globo', qty: 1, price: 58 }] });
  assert.equal(r.code, 409); assert.equal(st.cfdi, null);
});

test('facturama: valida receptor y no llama a Facturama', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', receptor: { ...receptor, rfc: 'MAL' }, items: [{ name: 'X', qty: 1, price: 10 }] });
  assert.equal(r.code, 400); assert.match(r.data.error, /RFC/); assert.equal(st.cfdi, null);
});

test('facturama: error de Facturama se devuelve legible y no guarda nada', async () => {
  const st = fake({ timbre: { ok: false, status: 400, text: async () => JSON.stringify({ Message: 'Régimen no válido' }) } });
  const r = await call({ accion: 'emitir', receptor, items: [{ name: 'X', qty: 1, price: 10 }] });
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
  await call({ accion: 'emitir', receptor, items: [{ name: 'X', qty: 1, price: 10 }] });
  assert.ok(st.calls.some(c => c.includes('https://api.facturama.mx/3/cfdis')));
  delete process.env.FACTURAMA_ENV;
});
