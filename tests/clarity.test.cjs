// Microsoft Clarity: lectura de la API de exportación (lib/clarity.js) y tablero de
// Estadísticas → Comportamiento (api/comportamiento.js). Los datos de prueba tienen la forma
// real que devolvió la API el 2026-10-30.
const test = require('node:test'), assert = require('node:assert/strict');
const clarity = require('../lib/clarity.js');

const frustr = (extra = {}, ses = 3, pct = 0) => ['DeadClickCount', 'ExcessiveScroll', 'RageClickCount', 'QuickbackClick', 'ScriptErrorCount', 'ErrorClickCount']
  .map(m => ({ metricName: m, information: [{ ...extra, subTotal: 0, pagesViews: 0, sessionsCount: ses, sessionsWithMetricPercentage: m === 'RageClickCount' ? pct : 0, sessionsWithoutMetricPercentage: 100 - (m === 'RageClickCount' ? pct : 0) }] }));
const TOTAL = (ses, rage, scroll) => [
  ...frustr({}, ses, rage),
  { metricName: 'ScrollDepth', information: [{ averageScrollDepth: scroll }] },
  { metricName: 'Traffic', information: [{ distinctUserCount: ses, totalSessionCount: ses, totalBotSessionCount: 0, pagesPerSessionPercentage: 1.5 }] },
  { metricName: 'EngagementTime', information: [{ totalTime: 40, activeTime: 30 }] },
  { metricName: 'Browser', information: [{ name: 'ChromeMobile', sessionsCount: ses }] },
  { metricName: 'ReferrerUrl', information: [{ name: 'l.facebook.com', sessionsCount: ses - 1 }, { name: 'www.google.com', sessionsCount: 1 }] },
  { metricName: 'PopularPages', information: [{ url: 'https://www.mifiestashop.com/', visitsCount: ses }] }
];
const URLS = [
  ...['DeadClickCount', 'RageClickCount', 'QuickbackClick'].map(m => ({ metricName: m, information: [
    { Url: 'https://www.mifiestashop.com/?utm_source=an&fbclid=abc', subTotal: 0, pagesViews: 0, sessionsCount: 2, sessionsWithMetricPercentage: m === 'QuickbackClick' ? 50 : 0, sessionsWithoutMetricPercentage: 50 },
    { Url: 'https://www.mifiestashop.com/', subTotal: 0, pagesViews: 0, sessionsCount: 2, sessionsWithMetricPercentage: 0, sessionsWithoutMetricPercentage: 100 },
    { Url: 'https://www.mifiestashop.com/?buscar=globos', subTotal: 0, pagesViews: 0, sessionsCount: 1, sessionsWithMetricPercentage: 0, sessionsWithoutMetricPercentage: 100 }
  ] })),
  { metricName: 'ScrollDepth', information: [{ Url: 'https://www.mifiestashop.com/?utm_source=an&fbclid=abc', averageScrollDepth: 10 }, { Url: 'https://www.mifiestashop.com/', averageScrollDepth: 50 }, { Url: 'https://www.mifiestashop.com/?buscar=globos', averageScrollDepth: 66 }] },
  { metricName: 'Traffic', information: [
    { Url: 'https://www.mifiestashop.com/?utm_source=an&fbclid=abc', distinctUserCount: 2, totalSessionCount: 2, totalBotSessionCount: 0, pagesPerSessionPercentage: 1 },
    { Url: 'https://www.mifiestashop.com/', distinctUserCount: 2, totalSessionCount: 2, totalBotSessionCount: 0, pagesPerSessionPercentage: 2 },
    { Url: 'https://www.mifiestashop.com/?buscar=globos', distinctUserCount: 1, totalSessionCount: 1, totalBotSessionCount: 0, pagesPerSessionPercentage: 2 }] }
];

test('normalizar: la dimensión llega como "Url" y las listas no se mezclan con las métricas', () => {
  const { filas, listas } = clarity.normalizar(TOTAL(3, 0, 52.25), []);
  assert.equal(filas.length, 1);
  const r = clarity.resumenFila(filas[0]);
  assert.deepEqual([r.sesiones, r.usuarios, r.scroll, r.tiempo_activo, r.clics_ira], [3, 3, 52.25, 30, 0]);
  assert.deepEqual(listas.ReferrerUrl, [{ nombre: 'l.facebook.com', sesiones: 2 }, { nombre: 'www.google.com', sesiones: 1 }]);
  assert.deepEqual(listas.PopularPages, [{ nombre: 'https://www.mifiestashop.com/', sesiones: 3 }]);
  const u = clarity.normalizar(URLS, ['URL']).filas;
  assert.equal(u.length, 3);
  assert.equal(u[0].dims.URL, 'https://www.mifiestashop.com/?utm_source=an&fbclid=abc');
  assert.equal(u[0].m.Traffic.totalSessionCount, 2);
});

test('api/comportamiento: junta días ponderando por sesiones, agrupa páginas y cruza con el embudo propio', async () => {
  const prev = global.fetch, prevTok = process.env.CLARITY_API_TOKEN;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr'; process.env.CLARITY_API_TOKEN = 't';
  require('../lib/sesion-panel.js').sesionPanel = async () => ({ nombre: 'Admin', es_admin: true, permisos: [] });
  const filasDb = [
    { fecha: '2026-10-29', dimension: '', datos: TOTAL(10, 10, 40) },
    { fecha: '2026-10-30', dimension: '', datos: TOTAL(30, 0, 60) },
    { fecha: '2026-10-30', dimension: 'URL', datos: URLS }
  ];
  global.fetch = async (url) => {
    const u = String(url);
    const ok = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('/clarity_diario')) return ok(filasDb);
    if (u.includes('ps_sync_estado')) return ok([{ last_synced_at: '2026-10-30T06:35:00Z', ultimo_resultado: '6 consultas' }]);
    if (u.includes('comportamiento_paginas')) return ok([{ path: '/', visitas: 50, carrito: 5, compra: 1, lcp_movil: 2400 }]);
    return ok([]);
  };
  try {
    const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
    await require('../api/comportamiento.js')({ method: 'POST', headers: {}, body: { dias: 7 } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const d = res.data;
    assert.equal(d.totales.sesiones, 40);
    assert.equal(d.totales.scroll, 55);            // (10×40 + 30×60) / 40
    assert.equal(d.totales.clics_ira, 2.5);        // (10×10 + 30×0) / 40
    assert.deepEqual(d.serie.map(x => x.fecha), ['2026-10-29', '2026-10-30']);
    // "/" y "/?utm...&fbclid" son la misma página; la búsqueda va aparte.
    const inicio = d.paginas.find(p => p.ruta === '/');
    assert.equal(inicio.sesiones, 4);
    assert.equal(inicio.scroll, 30);
    assert.equal(inicio.carrito_pct, 10);
    assert.equal(inicio.lcp_movil, 2400);
    assert.ok(d.paginas.some(p => p.ruta === '/?buscar=…'));
    assert.deepEqual(d.listas.ReferrerUrl[0], { nombre: 'l.facebook.com', sesiones: 38 });
  } finally { global.fetch = prev; if (prevTok === undefined) delete process.env.CLARITY_API_TOKEN; else process.env.CLARITY_API_TOKEN = prevTok; }
});

test('api/comportamiento: sin sesión no entrega nada', async () => {
  delete require.cache[require.resolve('../lib/sesion-panel.js')];
  delete require.cache[require.resolve('../api/comportamiento.js')];
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  await require('../api/comportamiento.js')({ method: 'POST', headers: {}, body: {} }, res);
  assert.equal(res.code, 401);
});
