const test = require('node:test'), assert = require('node:assert/strict');

function response() {
  return {
    code: 0, data: null, ended: false,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; },
    end() { this.ended = true; return this; }
  };
}

test('api/evento: guarda solo eventos válidos, limpia datos y no acepta campos inventados', async () => {
  let posted = null;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async (url, opts = {}) => { posted = JSON.parse(opts.body); return { ok: true, text: async () => '' }; };
  try {
    const res = response();
    // sendBeacon manda text/plain: el cuerpo llega como texto.
    const body = JSON.stringify({ events: [
      { v: 'visitante01', s: 'sesion0001', e: 'agregar_carrito', p: '/globos/1-globo.html', pid: '83281', val: 26, o: 'facebook', dv: 'movil', d: { nombre: 'Bombín', cantidad: 2, 'mal-campo': 'x', objeto: { a: 1 } } },
      { v: 'visitante01', s: 'sesion0001', e: 'evento_inventado' },
      { v: 'x', s: 'sesion0001', e: 'visita' },
      { v: 'visitante01', s: 'sesion0001', e: 'visita', o: 'hackers', dv: 'nave' }
    ] });
    await require('../api/evento.js')({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, body }, res);
    assert.equal(res.code, 204);
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[0].datos, { nombre: 'Bombín', cantidad: 2 });
    assert.equal(posted[0].producto_id, 83281);
    assert.equal(posted[0].origen, 'facebook');
    assert.equal(posted[1].origen, 'directo');
    assert.equal(posted[1].dispositivo, null);
    // Todas las filas con las mismas llaves (lote de PostgREST).
    assert.deepEqual(Object.keys(posted[0]).sort(), Object.keys(posted[1]).sort());
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/evento: ignora bots sin tocar la base', async () => {
  let called = false;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async () => { called = true; return { ok: true }; };
  try {
    const res = response();
    await require('../api/evento.js')({ method: 'POST', headers: { 'user-agent': 'facebookexternalhit/1.1' }, body: { events: [{ v: 'visitante01', s: 'sesion0001', e: 'visita' }] } }, res);
    assert.equal(res.code, 204);
    assert.equal(called, false);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/embudo: sin sesión válida no entrega nada', async () => {
  const prev = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => false });
  try {
    const res = response();
    await require('../api/embudo.js')({ method: 'POST', body: { accion: 'resumen', desde: '2026-09-01', hasta: '2026-09-02' } }, res);
    assert.equal(res.code, 401);
  } finally { global.fetch = prev; }
});

test('api/embudo: resumen llama las 4 funciones con el rango pedido y rechaza rangos de más de 90 días', async () => {
  const calls = [];
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return { ok: true, json: async () => true };
    const fn = u.split('/rpc/')[1];
    calls.push({ fn, params: JSON.parse(opts.body), key: opts.headers.apikey });
    return { ok: true, json: async () => (fn === 'embudo_agregado' ? [{ origen: 'facebook', dispositivo: 'movil', max_paso: 3, sesiones: 5 }] : []) };
  };
  try {
    const res = response();
    await require('../api/embudo.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'resumen', desde: '2026-09-28T06:00:00.000Z', hasta: '2026-09-29T06:00:00.000Z' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.deepEqual(calls.map(c => c.fn).sort(), ['embudo_abandonados', 'embudo_agregado', 'embudo_errores', 'embudo_sesiones']);
    assert.ok(calls.every(c => c.key === 'sr' && c.params.p_desde === '2026-09-28T06:00:00.000Z'));
    assert.equal(res.data.filas[0].sesiones, 5);

    const res2 = response();
    await require('../api/embudo.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'resumen', desde: '2026-01-01', hasta: '2026-09-01' } }, res2);
    assert.equal(res2.code, 400);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
