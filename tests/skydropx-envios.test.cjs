const test = require('node:test'), assert = require('node:assert/strict');
process.env.SKYDROPX_API_KEY = 'k'; process.env.SKYDROPX_API_SECRET = 's';
const handler = require('../api/skydropx-envios.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body: { p_admin_password: 'buena', ...body } }, res).then(() => res);
}
const resp = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data), json: async () => data });

function fake({ crear }) {
  const st = { shipments: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return resp(200, true);
    if (u.includes('/oauth/token')) return resp(200, { access_token: 't' });
    if (u.endsWith('/api/v1/shipments') && opts.method === 'POST') { const b = JSON.parse(opts.body); st.shipments.push(b); return crear(b, st.shipments.length); }
    if (u.includes('/api/v1/shipments/')) return resp(200, { data: { id: 'S1', attributes: { workflow_status: 'success' } }, included: [{ attributes: { label_url: 'http://x/pdf', tracking_number: 'T1' } }] });
    return resp(404, {});
  };
  return st;
}
const persona = { nombre: 'Ana', telefono: '55 1234 5678', email: 'a@b.mx' };
const body = (calleO, calleD) => ({ accion: 'crear', rate_id: 'R1', origen: { ...persona, calle: calleO }, destino: { ...persona, calle: calleD, referencia: 'Portón negro' } });

test('skydropx: una calle de más de 45 caracteres se corta y el resto va a la referencia', async () => {
  const st = fake({ crear: () => resp(202, { data: { id: 'S1', attributes: {} } }) });
  const larga = 'Calzada de Tlalpan esquina con Avenida Universidad número 1234 interior 5 colonia Portales Sur';
  const r = await call(body('Rumania 613', larga));
  assert.equal(r.code, 200, JSON.stringify(r.data));
  const sent = st.shipments[0].shipment;
  assert.ok(sent.address_to.street1.length <= 45);
  assert.equal(sent.address_from.street1, 'Rumania 613');
  assert.match(sent.address_to.reference, /^Universidad número 1234/);
  assert.match(sent.address_to.reference, /Portón negro/);
  assert.ok(sent.address_to.reference.length <= 100);
});

test('skydropx: si falla, el error mostrado es el del formato anidado, no el del reintento aplanado', async () => {
  fake({ crear: (b) => b.shipment
    ? resp(422, { errors: { 'Address from street1': ['es demasiado largo'] } })
    : resp(422, { errors: { address_from: ['no puede estar en blanco'], rate_id: ['no puede estar en blanco'] } }) });
  const r = await call(body('Rumania 613', 'Calle 1'));
  assert.equal(r.code, 502);
  assert.match(r.data.detail, /street1/);
  assert.ok(!/rate_id/.test(r.data.detail));
});

test('skydropx: etiqueta baja el PDF desde el servidor y lo devuelve en base64', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return resp(200, true);
    if (u.includes('/oauth/token')) return resp(200, { access_token: 't' });
    if (u.includes('/api/v1/shipments/S1')) return resp(200, { data: { id: 'S1', attributes: { master_tracking_number: 'T1' } }, included: [{ attributes: { label_url: 'https://cdn.x/label.pdf', tracking_number: 'T1' } }] });
    if (u === 'https://cdn.x/label.pdf') return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => Buffer.from('%PDF-1.4 hola') };
    return resp(404, {});
  };
  const r = await call({ accion: 'etiqueta', shipment_id: 'S1' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(Buffer.from(r.data.content, 'base64').toString(), '%PDF-1.4 hola');
  assert.equal(r.data.filename, 'guia-T1.pdf');
});

test('skydropx: encuentra la liga del PDF aunque venga en otro lugar de la respuesta', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return resp(200, true);
    if (u.includes('/oauth/token')) return resp(200, { access_token: 't' });
    if (u.includes('/api/v1/shipments/S2')) return resp(200, { data: { id: 'S2', attributes: { workflow_status: 'success' } }, included: [{ type: 'labels', attributes: { files: [{ label_url: 'https://cdn.x/otra.pdf' }] } }] });
    if (u === 'https://cdn.x/otra.pdf') return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => Buffer.from('%PDF') };
    return resp(404, {});
  };
  const r = await call({ accion: 'etiqueta', shipment_id: 'S2' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
});

test('skydropx: sin PDF, el error dice el estado y qué trae el envío', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return resp(200, true);
    if (u.includes('/oauth/token')) return resp(200, { access_token: 't' });
    if (u.includes('/api/v1/shipments/S3')) return resp(200, { data: { id: 'S3', attributes: { workflow_status: 'in_progress', carrier_name: 'X' } }, included: [] });
    return resp(404, {});
  };
  const r = await call({ accion: 'etiqueta', shipment_id: 'S3' });
  assert.equal(r.code, 409);
  assert.match(r.data.error, /in_progress/);
  assert.match(r.data.detail, /carrier_name/);
});
