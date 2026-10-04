const test = require('node:test'), assert = require('node:assert/strict');
const blog = require('../lib/blog.js');

function response() {
  return { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, json(d) { this.body = d; return this; } };
}

test('sanitizeHtml quita scripts, eventos y enlaces javascript:', () => {
  const sucio = '<p onclick="x()">Hola <b>mundo</b></p><script>alert(1)</script><img src="javascript:alert(1)" onerror="x"><a href="javascript:alert(1)">mal</a><a href="/266-productos" target="_blank">bien</a><iframe src="https://x"></iframe><style>p{}</style><h2 style="color:red">Sección</h2>';
  const limpio = blog.sanitizeHtml(sucio);
  assert.doesNotMatch(limpio, /script|onclick|onerror|javascript:|iframe|style/i);
  assert.match(limpio, /<p>Hola <b>mundo<\/b><\/p>/);
  assert.match(limpio, /<a href="\/266-productos" target="_blank" rel="noopener">bien<\/a>/);
  assert.match(limpio, /<a>mal<\/a>/);
  assert.match(limpio, /<h2>Sección<\/h2>/);
});

test('slugify y anclas del índice', () => {
  assert.equal(blog.slugify('10 Ideas para tu Batucada de Boda ¡Neón!'), '10-ideas-para-tu-batucada-de-boda-neon');
  const { html, indice } = blog.conAnclas('<h2>Qué llevar</h2><p>x</p><h2>Qué llevar</h2>');
  assert.equal(indice.length, 2);
  assert.match(html, /<h2 id="que-llevar">/);
  assert.match(html, /<h2 id="que-llevar-2">/);
});

const POST = { id: 1, slug: 'ideas-batucada', titulo: 'Ideas para batucada', resumen: 'Resumen', contenido: '<h2>Uno</h2><p>texto</p>', imagen: 'https://img/x.jpg', palabra_clave: 'batucada', etiquetas: ['boda'], estado: 'publicado', publicado_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-02T12:00:00Z', autor: 'Ana' };

test('el artículo trae canonical, BlogPosting y migas', () => {
  const html = blog.renderPost(POST, []);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.mifiestashop\.com\/blog\/ideas-batucada">/);
  assert.match(html, /"@type":"BlogPosting"/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.match(html, /<h1>Ideas para batucada<\/h1>/);
  assert.match(html, /data-terms=/);
});

function mockSb(rows) {
  const urls = [];
  global.fetch = async url => { urls.push(decodeURIComponent(String(url))); return { ok: true, json: async () => rows(String(url)) }; };
  return urls;
}

test('api/blog: artículo publicado, 404 y solo publicados', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const handler = require('../api/blog.js');
  const urls = mockSb(u => (u.includes('slug=eq.ideas-batucada') ? [POST] : u.includes('slug=eq.') ? [] : []));
  try {
    let res = response(); await handler({ query: { slug: 'ideas-batucada' } }, res);
    assert.equal(res.code, 200); assert.match(res.body, /Ideas para batucada/);
    assert.ok(urls[0].includes('estado=eq.publicado') && urls[0].includes('publicado_at=lte.'));
    res = response(); await handler({ query: { slug: 'no-existe' } }, res);
    assert.equal(res.code, 404);
    res = response(); await handler({ query: { slug: '../etc' } }, res);
    assert.equal(res.code, 404);
    res = response(); await handler({ query: {} }, res);
    assert.equal(res.code, 200); assert.match(res.body, /Blog de fiestas/);
  } finally { global.fetch = prev; }
});

test('api/blog-admin pide sesión y limpia el HTML al guardar', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const handler = require('../api/blog-admin.js');
  let guardado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return json(JSON.parse(opts.body).p_admin_password === 'ok');
    if (u.includes('blog_posts') && opts.method === 'POST') { guardado = JSON.parse(opts.body); return json([{ id: 5, ...guardado }]); }
    return json([]);
  };
  try {
    let res = response(); await handler({ method: 'POST', body: { accion: 'listar' } }, res);
    assert.equal(res.code, 401);
    res = response();
    await handler({ method: 'POST', body: { p_admin_password: 'ok', accion: 'guardar', post: { titulo: 'Hola Mundo', contenido: '<p>x</p><script>1</script>', estado: 'publicado' } } }, res);
    assert.equal(res.code, 200);
    assert.equal(guardado.slug, 'hola-mundo');
    assert.equal(guardado.contenido, '<p>x</p>');
    assert.ok(guardado.publicado_at);
  } finally { global.fetch = prev; }
});
