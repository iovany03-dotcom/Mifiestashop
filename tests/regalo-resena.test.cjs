const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const handler = require('../api/pedido-admin.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body: { p_admin_password: 'buena', ...body } }, res).then(() => res);
}
const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data });

function fake(items) {
  const st = { items, patched: null, subidas: [], historial: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return ok(JSON.parse(opts.body).p_admin_password === 'buena');
    if (u.includes('rpc_check_admin')) return ok(true);
    if (u.includes('/storage/v1/object/assets/resenas/')) { st.subidas.push(u); return ok({ Key: 'x' }); }
    if (u.includes('pedido_historial')) { st.historial.push(JSON.parse(opts.body)); return ok(null); }
    if (u.includes('personal_equipo') || u.includes('rpc_staff') || u.includes('actor')) return ok([{ nombre: 'Ana' }]);
    if (u.includes('pos_tickets')) {
      if (opts.method === 'PATCH') { st.patched = JSON.parse(opts.body); st.items = st.patched.items; return ok(null); }
      return ok([{ items: st.items }]);
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  return st;
}
const ticket = () => [
  { product_id: 1, name: 'Globo', qty: 2, price: 5 },
  { product_id: 2, name: 'Sombrero', qty: 1, price: 0, regalo: true, precio_regular: 15 }
];

test('regalo por reseña: adjunta liga y comentario a la línea de regalo', async () => {
  const st = fake(ticket());
  const r = await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1, url: 'https://g.page/r/abc', comentario: ' Muy buen servicio ' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(st.items[1].resena.url, 'https://g.page/r/abc');
  assert.equal(st.items[1].resena.comentario, 'Muy buen servicio');
  assert.ok(st.items[1].resena.fecha);
  assert.equal(st.items[0].resena, undefined, 'las líneas pagadas no se tocan');
  assert.ok(st.historial.length >= 1);
});

test('regalo por reseña: solo en líneas de regalo y con datos válidos', async () => {
  fake(ticket());
  assert.equal((await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 0, comentario: 'x' })).code, 400, 'línea pagada');
  assert.equal((await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1, url: 'javascript:alert(1)' })).code, 400, 'liga no https');
  assert.equal((await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1 })).code, 400, 'sin nada que guardar');
  assert.equal((await call({ accion: 'resena_regalo', origen: 'online', folio: 'WEB-1', linea: 1, comentario: 'x' })).code, 400, 'solo POS');
  assert.equal((await call({ p_admin_password: 'mala', accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1, comentario: 'x' })).code, 401, 'sin sesión');
});

test('regalo por reseña: sube la captura al almacenamiento y se puede quitar la reseña', async () => {
  const st = fake(ticket());
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const r = await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1, imagen: { media_type: 'image/png', data: png } });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(st.subidas.length, 1);
  assert.match(st.items[1].resena.imagen, /\/storage\/v1\/object\/public\/assets\/resenas\/POS-1-.*\.png$/);
  const mala = await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1, imagen: { media_type: 'text/html', data: 'eA==' } });
  assert.equal(mala.code, 400);
  const q = await call({ accion: 'resena_regalo', origen: 'pos', folio: '#POS-1', linea: 1, quitar: true });
  assert.equal(q.code, 200);
  assert.equal(st.items[1].resena, undefined);
});
