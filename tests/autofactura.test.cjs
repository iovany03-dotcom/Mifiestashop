// Autofactura de clientes (/facturar → api/autofactura.js): solo tickets del POS cobrados con IVA,
// encontrados por folio Y total, sin repetir factura y descargables solo con el RFC con que se emitió.
const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.FACTURAMA_USER = 'usr'; process.env.FACTURAMA_PASSWORD = 'pwd'; process.env.FACTURAMA_EXPEDITION_PLACE = '72000';
const handler = require('../api/autofactura.js');

const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
const hoy = new Date().toISOString();
const TICKETS = {
  // Con "Aplicar IVA": subtotal + 16% = total.
  '#POS-12278': { folio: '#POS-12278', subtotal: 100, iva: 16, total: 116, metodo: 'card', created_at: hoy, almacen: 'Puebla', items: [{ product_id: '1', name: 'Globo', qty: 4, price: 25 }] },
  '#POS-50000': { folio: '#POS-50000', subtotal: 100, iva: 0, total: 100, metodo: 'cash', created_at: hoy, items: [{ product_id: '7', name: 'Vela', qty: 4, price: 25 }] },
  '#POS-60000': { folio: '#POS-60000', subtotal: 100, iva: 16, total: 116, metodo: 'cash', created_at: '2020-01-01T10:00:00Z', items: [{ product_id: '7', name: 'Vela', qty: 4, price: 25 }] }
};

function fake({ facturas = [] } = {}) {
  const st = { cfdi: null, facturas: [...facturas], calls: [] };
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url)); st.calls.push(`${opts.method || 'GET'} ${u}`);
    if (u.includes('facturama.mx')) {
      if (u.endsWith('/3/cfdis')) { st.cfdi = JSON.parse(opts.body); return ok({ Id: 'FX123456', Folio: st.cfdi.Folio, Total: 116, Complement: { TaxStamp: { Uuid: 'UUID-9' } } }); }
      if (u.includes('/cfdi/pdf/')) return ok({ Content: 'JVBER' });
      return ok({ success: true });
    }
    if (u.includes('/rest/v1/pos_tickets')) {
      const t = TICKETS[u.match(/folio=eq\.([^&]+)/)[1]];
      const ge = u.match(/total=gte\.([\d.]+)/), le = u.match(/total=lte\.([\d.]+)/);
      return ok(t && (!ge || (t.total >= Number(ge[1]) && t.total <= Number(le[1]))) ? [t] : []);
    }
    if (u.includes('/rest/v1/facturas')) {
      if (opts.method === 'POST') { st.facturas.push(...JSON.parse(opts.body)); return ok(null); }
      return ok(st.facturas.filter(f => u.includes(`pedido_folio=eq.${f.pedido_folio}`)));
    }
    return ok([]);
  };
  return st;
}
function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body }, res).then(() => res);
}
const RECEPTOR = { rfc: 'XAXX010101ABC', nombre: 'Ana Pérez', cp: '72000', regimen: '612', usoCfdi: 'G03' };

test('ticket con IVA: se encuentra con folio y total, y se puede facturar', async () => {
  fake();
  const r = await call({ accion: 'buscar', folio: 'POS-12278', total: '$116.00' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(r.data.ticket.facturable, true);
  assert.equal(r.data.ticket.iva, 16);
  assert.equal(r.data.ticket.tarjeta, true);
  assert.equal(r.data.ticket.conceptos[0].importe, 116); // precios del POS sin IVA → con IVA en la factura
});

test('ticket sin IVA: no se deja facturar', async () => {
  const st = fake();
  const r = await call({ accion: 'buscar', folio: '50000', total: '100' });
  assert.equal(r.data.ticket.facturable, false);
  assert.match(r.data.ticket.motivo, /sin IVA/);
  const e = await call({ accion: 'emitir', folio: '50000', total: '100', email: 'a@b.com', receptor: RECEPTOR });
  assert.equal(e.code, 409);
  assert.ok(!st.calls.some(c => c.includes('facturama.mx')), 'no se timbra nada');
});

test('total equivocado: no encuentra el ticket (no se pueden adivinar folios)', async () => {
  fake();
  const r = await call({ accion: 'buscar', folio: 'POS-12278', total: '200' });
  assert.equal(r.code, 404);
  const sinTotal = await call({ accion: 'buscar', folio: 'POS-12278' });
  assert.equal(sinTotal.code, 400);
});

test('ticket viejo: fuera del plazo', async () => {
  fake();
  const r = await call({ accion: 'buscar', folio: '60000', total: '116' });
  assert.equal(r.data.ticket.facturable, false);
  assert.match(r.data.ticket.motivo, /más de 30 días/);
});

test('emitir: conceptos del ticket, forma de pago del ticket (tarjeta → la que elige), y no se repite', async () => {
  const st = fake();
  const r = await call({ accion: 'emitir', folio: '12278', total: '116', email: 'ana@correo.com', formaPago: '28', receptor: RECEPTOR, items: [{ name: 'Inventado', qty: 1, price: 1 }] });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(r.data.factura.uuid, 'UUID-9');
  assert.equal(st.cfdi.PaymentForm, '28');
  assert.equal(st.cfdi.PaymentMethod, 'PUE');
  assert.equal(st.cfdi.Items.length, 1);
  assert.equal(st.cfdi.Items[0].Description, 'Globo');
  assert.equal(st.cfdi.Items[0].Total, 116);
  assert.equal(st.facturas[0].creado_por, 'Autofactura (cliente)');
  const otra = await call({ accion: 'emitir', folio: '12278', total: '116', email: 'ana@correo.com', receptor: RECEPTOR });
  assert.equal(otra.code, 409);
  const b = await call({ accion: 'buscar', folio: '12278', total: '116' });
  assert.equal(b.data.ticket.ya_facturado, true);
});

test('descargar: solo con el RFC con el que se facturó', async () => {
  fake({ facturas: [{ pedido_folio: '#POS-12278', facturama_id: 'FX123456', rfc: 'XAXX010101ABC', estado: 'activa', entorno: 'sandbox' }] });
  const mal = await call({ accion: 'descargar', folio: '12278', total: '116', rfc: 'OTRO010101AAA' });
  assert.equal(mal.code, 404);
  const bien = await call({ accion: 'descargar', folio: '12278', total: '116', rfc: 'xaxx010101abc' });
  assert.equal(bien.code, 200);
  assert.equal(bien.data.content, 'JVBER');
});

test('buscar: si el folio trae menos de 5 cifras, avisa que puede faltar un dígito (sin revelar si existe)', async () => {
  fake();
  const corto = await call({ accion: 'buscar', folio: 'POS-1227', total: '116' });
  assert.equal(corto.code, 404);
  assert.match(corto.data.error, /5 cifras/);
  const completo = await call({ accion: 'buscar', folio: 'POS-99999', total: '116' });
  assert.equal(completo.code, 404);
  assert.doesNotMatch(completo.data.error, /5 cifras/);
});
