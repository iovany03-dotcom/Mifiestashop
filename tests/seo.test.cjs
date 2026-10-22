const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('crypto');
const { auditarHtml, auditarProducto, tipoDePagina } = require('../lib/seo-auditor.js');

const URL_P = 'https://www.mifiestashop.com/batucada/83337-corona-rey-cruz-8625725190187.html';
const info = (extra = {}) => ({ url: URL_P, status: 200, ms: 300, bytes: 40000, urlFinal: URL_P, ...extra });
const PAGINA_BUENA = `<!doctype html><html lang="es-MX"><head>
<title>Corona rey con cruz dorada para batucada | Mi Fiestashop</title>
<meta content="Corona de rey con cruz dorada para batucada, bodas y XV años. Precio de mayoreo y envío a todo México. Compra en línea o en tienda." name="description">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${URL_P}" rel="canonical">
<meta property="og:title" content="Corona rey"><meta property="og:image" content="https://x/c.webp">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Corona","offers":{"@type":"Offer","price":"25.00"}},{"@type":"BreadcrumbList","itemListElement":[]}]}</script>
</head><body><h1>Corona rey con cruz</h1><img src="a.jpg" alt="Corona rey dorada">
<p>${'Corona de plástico dorada ideal para batucada y fiestas temáticas. '.repeat(20)}</p>
<a href="/266-productos">Productos</a><a href="/batucada">Batucada</a><a href="https://www.mifiestashop.com/">Inicio</a></body></html>`;

test('una página bien hecha saca 100', () => {
  const r = auditarHtml(PAGINA_BUENA, info());
  assert.equal(r.datos.tipo, 'producto');
  assert.deepEqual(r.problemas.map(p => p.codigo), []);
  assert.equal(r.puntaje, 100);
});

test('detecta los problemas típicos y los ordena por impacto', () => {
  const html = `<html><head><title>Corona</title><meta name="robots" content="noindex">
    <script type="application/ld+json"></script></head><body><h1>A</h1><h1 class="x">B</h1><img src="1.jpg"><img src="2.jpg" alt=""></body></html>`;
  const r = auditarHtml(html, info({ bytes: 900 * 1024 }));
  const c = r.problemas.map(p => p.codigo);
  ['noindex', 'sin_descripcion', 'sin_canonical', 'varios_h1', 'img_sin_alt', 'jsonld_error', 'sin_schema_producto', 'sin_viewport', 'html_pesado', 'titulo_corto', 'poco_contenido'].forEach(k => assert.ok(c.includes(k), `falta ${k}`));
  assert.equal(r.problemas[0].nivel, 'critico');
  assert.ok(r.puntaje < 30);
});

test('404 y tipos de página', () => {
  assert.equal(auditarHtml('', info({ status: 404 })).problemas[0].codigo, 'http_error');
  assert.equal(tipoDePagina('https://www.mifiestashop.com/'), 'inicio');
  assert.equal(tipoDePagina('https://www.mifiestashop.com/content/269-boda'), 'cms');
  assert.equal(tipoDePagina('https://www.mifiestashop.com/blog/ideas-xv'), 'articulo');
});

test('puntaje de producto del catálogo', () => {
  const malo = auditarProducto({ name: 'Gorro', description: 'Gorro', images: [], category_label: 'Inicio' });
  assert.ok(malo.problemas.some(p => p.codigo === 'sin_foto'));
  assert.ok(malo.problemas.some(p => p.codigo === 'sin_meta_title'));
  const bueno = auditarProducto({ name: 'Gorro de fiesta metálico dorado', meta_title: 'Gorro de fiesta metálico dorado', meta_description: 'x'.repeat(130),
    description: 'palabra '.repeat(150), images: ['a', 'b'], category_label: 'Cumpleaños' });
  assert.equal(bueno.puntaje, 100);
});

// ---- API ----
function response() { return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } }; }

test('el módulo exige sesión con permiso SEO', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const handler = require('../api/seo.js');
  global.fetch = async url => ({ ok: true, status: 200, text: async () => JSON.stringify(String(url).includes('seo_sesion') ? [{ nombre: 'Ana', permitido: false }] : []) });
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'config', creds: { p_staff_email: 'a', p_staff_pin: '1' } } }, res);
    assert.equal(res.code, 403);
  } finally { global.fetch = prev; }
});

test('guardar_producto limpia el HTML y actualiza también productos_migrados', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const handler = require('../api/seo.js');
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url); llamadas.push({ u, opts });
    const r = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('seo_sesion')) return r([{ nombre: 'Admin', permitido: true }]);
    if (u.includes('catalogo_productos')) return r([{ id: 5 }]);
    return r(null);
  };
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'guardar_producto', creds: {}, id: 5, meta_title: 'Collar hawaiano | Mi Fiestashop', meta_description: 'Collar  hawaiano   para fiesta', descripcion: '<p onclick="x()">Hola</p><script>alert(1)</script><img src=x onerror=y>' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const patch = JSON.parse(llamadas.find(l => l.u.includes('catalogo_productos')).opts.body);
    assert.equal(patch.meta_title, 'Collar hawaiano');
    assert.equal(patch.meta_description, 'Collar hawaiano para fiesta');
    assert.equal(patch.description, '<p>Hola</p>');
    assert.ok(llamadas.some(l => l.u.includes('productos_migrados') && l.opts.method === 'PATCH'));
  } finally { global.fetch = prev; }
});

test('Search Console: firma el token con la cuenta de servicio y consulta la propiedad', async () => {
  const prev = global.fetch;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'seo@proyecto.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  delete require.cache[require.resolve('../lib/seo-google.js')];
  const google = require('../lib/seo-google.js');
  let consulta = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      const jwt = new URLSearchParams(opts.body).get('assertion').split('.');
      const ok = crypto.createVerify('RSA-SHA256').update(`${jwt[0]}.${jwt[1]}`).verify(publicKey, Buffer.from(jwt[2], 'base64url'));
      assert.ok(ok, 'firma válida');
      assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).iss, 'seo@proyecto.iam.gserviceaccount.com');
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    consulta = { u, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return { ok: true, text: async () => JSON.stringify({ rows: [{ keys: ['batucada cdmx'], clicks: 12, impressions: 340, ctr: 0.0353, position: 6.42 }] }) };
  };
  try {
    const filas = await google.analitica({ startDate: '2026-09-01', endDate: '2026-09-28', dimensiones: ['query'] });
    assert.equal(consulta.auth, 'Bearer tok');
    assert.match(consulta.u, /sites\/sc-domain%3Amifiestashop\.com\/searchAnalytics\/query/);
    assert.deepEqual(filas[0], { keys: ['batucada cdmx'], clics: 12, impresiones: 340, ctr: 3.53, posicion: 6.4 });
  } finally { global.fetch = prev; delete process.env.GSC_SERVICE_ACCOUNT_JSON; }
});

test('PageSpeed: lee calificaciones, métricas y oportunidades', async () => {
  const prev = global.fetch;
  const google = require('../lib/seo-google.js');
  global.fetch = async () => ({ ok: true, json: async () => ({
    lighthouseResult: {
      categories: { performance: { score: 0.42 }, seo: { score: 0.92 }, accessibility: { score: 0.81 }, 'best-practices': { score: 0.77 } },
      audits: {
        'largest-contentful-paint': { numericValue: 5234 }, 'cumulative-layout-shift': { numericValue: 0.12 }, 'total-blocking-time': { numericValue: 812 },
        'first-contentful-paint': { numericValue: 2100 }, 'speed-index': { numericValue: 4000 },
        'unused-javascript': { title: 'Reduce el JavaScript sin usar', score: 0.2, details: { type: 'opportunity', overallSavingsMs: 2400 } }
      }
    }
  }) });
  try {
    const r = await google.pagespeed('https://www.mifiestashop.com/', 'mobile');
    assert.equal(r.performance, 42); assert.equal(r.seo, 92); assert.equal(r.lcp_ms, 5234); assert.equal(r.cls, 0.12);
    assert.equal(r.detalle.oportunidades[0].titulo, 'Reduce el JavaScript sin usar');
  } finally { global.fetch = prev; }
});

test('categorías: la IA propone y guardar limpia el HTML y las preguntas frecuentes', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const handler = require('../api/seo.js');
  const ia = require('../lib/recepcion-ia.js');
  const prevIA = ia.generarJson;
  let pedidoIA = null;
  ia.generarJson = async o => { pedidoIA = o; return { palabra_clave: 'globos para fiesta', meta_title: 'Globos para fiesta al mayoreo', meta_description: 'x'.repeat(140), intro_html: '<h2 onclick="x()">Globos</h2><p>Hola</p><script>alert(1)</script>', faq: [{ pregunta: '¿Hay mayoreo?', respuesta: '<b>Sí</b>, en muchos.' }, { pregunta: '', respuesta: 'vacía' }] }; };
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url); llamadas.push({ u, opts });
    const r = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('seo_sesion')) return r([{ nombre: 'Admin', permitido: true }]);
    if (u.includes('ps_categorias') && opts.method === 'PATCH') return r([{ id: 269, ...JSON.parse(opts.body) }]);
    if (u.includes('ps_categorias')) return r([{ id: 269, name: 'Globos', description: null }]);
    if (u.includes('catalogo_productos')) return r([{ name: 'Globo rojo', price: 10, price_mayoreo: 8 }, { name: 'Globo azul', price: 30 }]);
    return r(null);
  };
  try {
    let res = response();
    await handler({ method: 'POST', body: { accion: 'categoria_ia', creds: {}, id: 269 } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.intro_html, '<h2>Globos</h2><p>Hola</p>');
    assert.deepEqual(res.data.faq, [{ pregunta: '¿Hay mayoreo?', respuesta: 'Sí , en muchos.' }]);
    const datosIA = JSON.parse(pedidoIA.contenido[0].text);
    assert.deepEqual(datosIA.rango_precios_mxn, [10, 30]);
    assert.equal(datosIA.hay_mayoreo, true);

    res = response();
    const intro = '<p>' + 'palabra '.repeat(160) + '</p><img src=x onerror=y>';
    await handler({ method: 'POST', body: { accion: 'guardar_categoria', creds: {}, id: 269, meta_title: 'Globos para fiesta | Mi Fiestashop', meta_description: 'y'.repeat(130), descripcion: intro, faq: [{ pregunta: 'a?', respuesta: 'b' }, { pregunta: 'c?', respuesta: 'd' }, { pregunta: 'e?', respuesta: 'f' }] } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const patch = JSON.parse(llamadas.find(l => l.u.includes('ps_categorias') && l.opts.method === 'PATCH').opts.body);
    assert.equal(patch.meta_title, 'Globos para fiesta');
    assert.ok(!patch.description.includes('onerror'));
    assert.equal(patch.faq.length, 3);
    assert.equal(res.data.puntaje, 100);
  } finally { global.fetch = prev; ia.generarJson = prevIA; }
});
