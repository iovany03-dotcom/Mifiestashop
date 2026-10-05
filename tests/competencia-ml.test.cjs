const test = require('node:test'), assert = require('node:assert/strict');
const ml = require('../lib/competencia-ml.js');

test('piezas: paquetes, docenas y medidas que no son paquete', () => {
  assert.equal(ml.piezasDeTexto('Collar Hawaiano Neon 50 Pzas'), 50);
  assert.equal(ml.piezasDeTexto('Paquete De 12 Antifaz'), 12);
  assert.equal(ml.piezasDeTexto('Corbata neon c/100'), 100);
  assert.equal(ml.piezasDeTexto('2 Docenas Lentes'), 24);
  assert.equal(ml.piezasDeTexto('Pantuflas Desechables 50 Pares'), 50);
  assert.equal(ml.piezasDeTexto('Globo 18 Pulgadas'), 1);
  assert.equal(ml.piezasDeTexto('Vaso 16 oz'), 1);
  assert.equal(ml.piezasDeTexto('Lona 50 x 70 cm'), 1);
  assert.equal(ml.piezasDePublicacion({ title: 'Collar hawaiano', attributes: [{ id: 'UNITS_PER_PACK', value_name: '24' }] }), 24);
});

function mockML(results, { sbActual = [] } = {}) {
  const llamadas = { escrito: null, busqueda: null };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (d, ok = true, status = 200) => ({ ok, status, json: async () => d, text: async () => '' });
    if (u.includes('/oauth/token')) return json({ access_token: 'tok', expires_in: 21600 });
    if (u.includes('/sites/MLM/search')) { llamadas.busqueda = u; return json({ results }); }
    if (u.includes('/rest/v1/producto_privado') && (!opts.method || opts.method === 'GET')) return json([{ competencia: sbActual }]);
    if (u.includes('/rest/v1/producto_privado') && opts.method === 'POST') { llamadas.escrito = JSON.parse(opts.body); return json(null); }
    throw new Error('fetch inesperado ' + u);
  };
  return llamadas;
}

test('busca en ML, filtra lo que no se parece y ordena por precio por pieza', async () => {
  const prev = global.fetch;
  process.env.ML_CLIENT_ID = 'id'; process.env.ML_CLIENT_SECRET = 'sec';
  const ll = mockML([
    { title: 'Collar Hawaiano Neon 50 Pzas Fiesta', price: 150, permalink: 'https://ml/a', currency_id: 'MXN' },
    { title: 'Collar Hawaiano Neon Paquete 100', price: 200, permalink: 'https://ml/b', currency_id: 'MXN' },
    { title: 'Pulsera neon luminosa', price: 10, permalink: 'https://ml/c', currency_id: 'MXN' },
    { title: 'Collar Hawaiano Neon', price: 9, permalink: 'https://ml/d', currency_id: 'MXN' }
  ]);
  try {
    const { consulta, resultados } = await ml.buscarCompetenciaML({ name: 'Collar hawaiano neón', price: 7 });
    assert.equal(consulta, 'collar hawaiano neon');
    assert.match(ll.busqueda, /q=collar%20hawaiano%20neon/);
    assert.deepEqual(resultados.map(r => r.enlace), ['https://ml/b', 'https://ml/a', 'https://ml/d']);
    assert.equal(resultados[0].piezas, 100);
    assert.equal(resultados[0].precio_pieza, 2);
    assert.equal(resultados[0].fuente, 'mercadolibre');
  } finally { global.fetch = prev; }
});

test('guardar conserva los competidores capturados a mano', async () => {
  const prev = global.fetch;
  const manual = { nombre: 'Party City', precio: 12, enlace: 'https://x' };
  const viejoML = { nombre: 'Mercado Libre', precio: 99, fuente: 'mercadolibre', enlace: 'https://ml/old' };
  const ll = mockML([], { sbActual: [manual, viejoML] });
  try {
    const nuevo = { nombre: 'Mercado Libre', precio: 50, piezas: 10, precio_pieza: 5, enlace: 'https://ml/new', fuente: 'mercadolibre' };
    await ml.guardarCompetenciaML({ supabaseUrl: 'https://sb', serviceKey: 's', id: 7, resultados: [nuevo] });
    assert.deepEqual(ll.escrito[0].competencia, [manual, nuevo]);
  } finally { global.fetch = prev; }
});

test('nuestro precio por pieza cuando el producto es un paquete', () => {
  assert.deepEqual(ml.nuestroPrecioPieza({ name: 'Globo salchicha (200 pzas)', price: 90 }), { piezas: 200, precio_pieza: 0.45 });
  assert.deepEqual(ml.nuestroPrecioPieza({ name: 'Diadema con mechudo', price: 6 }), { piezas: 1, precio_pieza: 6 });
});

test('api/competencia-buscar pide sesión', async () => {
  const prev = global.fetch;
  global.fetch = async u => ({ ok: true, json: async () => (String(u).includes('rpc_check_session') ? false : []) });
  try {
    const handler = require('../api/competencia-buscar.js');
    const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
    await handler({ method: 'POST', body: { ids: [1] } }, res);
    assert.equal(res.code, 401);
  } finally { global.fetch = prev; }
});
