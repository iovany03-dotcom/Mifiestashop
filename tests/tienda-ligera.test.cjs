// "Tienda ligera" (middleware.js): a las páginas públicas se les quita el panel de administración
// y el código se manda aparte en /app/<hash>.js (api/app-js.js). Si alguien cambia index.html y
// esto deja de cuadrar (hash distinto, panel que se cuela, varios H1), estas pruebas lo detectan.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('url');

const RAIZ = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');

async function cargarMiddleware() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-'));
  const src = fs.readFileSync(path.join(RAIZ, 'middleware.js'), 'utf8')
    .replace("import cmsManifest from './data/cms-manifest.json';",
      `import fs from 'node:fs';\nconst cmsManifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(RAIZ, 'data/cms-manifest.json'))}, 'utf8'));`);
  const f = path.join(dir, 'mw.mjs');
  fs.writeFileSync(f, src);
  return (await import(pathToFileURL(f).href)).default;
}

const PRODUCTO = { id: 83334, name: 'Corbata tricolor', sku: 'X', link_rewrite: 'corbata-tricolor', barcode: '8625553470916', category_id: 271, active: true,
  description: '<p>Corbata de plástico ajustable</p><script>alert(1)</script>', images: ['https://x/1.webp'], meta_title: null, meta_description: null, price: 9,
  price_mayoreo: 7, price_mayoreo_desde_unidades: 12 };

function mockFetch() {
  global.fetch = async (url, opts = {}) => {
    const h = opts.headers instanceof Headers ? opts.headers : new Headers(opts.headers || {});
    if (h.get('x-mfs-mw-bypass')) return new Response(INDEX, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const u = decodeURIComponent(String(url));
    const json = d => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/catalogo_productos?id=eq.')) return json([PRODUCTO]);
    if (u.includes('/catalogo_productos?category_id=eq.')) return json([{ id: 83334, name: 'Corbata tricolor', price: 9, link_rewrite: 'corbata-tricolor', barcode: '8625553470916' }]);
    if (u.includes('/ps_categorias?id=eq.')) return json([{ id: 271, name: 'Fiesta Mexicana', link_rewrite: 'fiesta-mexicana', active: true, description: '<p>Todo para tu fiesta mexicana.</p>' }]);
    if (u.includes('/productos_migrados')) return json([]);
    return json([]);
  };
}

test('inicio, producto y categoría salen ligeros, con un solo H1 y el código aparte', async () => {
  const prev = global.fetch;
  mockFetch();
  try {
    const mw = await cargarMiddleware();
    const { hash } = require('../api/app-js.js').cargar();
    for (const [url, tipo] of [['https://www.mifiestashop.com/', 'inicio'], ['https://www.mifiestashop.com/fiesta-mexicana/83334-corbata-tricolor-8625553470916.html', 'producto'], ['https://www.mifiestashop.com/271-fiesta-mexicana', 'categoria']]) {
      const r = await mw(new Request(url));
      assert.ok(r, `${tipo}: el middleware debe responder`);
      assert.equal(r.status, 200, tipo);
      const html = await r.text();
      assert.ok(Buffer.byteLength(html) < 400 * 1024, `${tipo}: pesa ${Math.round(Buffer.byteLength(html) / 1024)} KB`);
      assert.ok(!html.includes('id="adminDashboardWrapper"'), `${tipo}: no debe llevar el panel`);
      assert.ok(!html.includes('id="traspasoModal"'), `${tipo}: no debe llevar ventanas del panel`);
      assert.ok(html.includes(`<script src="/app/${hash}.js"></script>`), `${tipo}: el hash del código debe coincidir con /api/app-js`);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${tipo}: un solo H1`);
      if (tipo === 'producto') {
        assert.match(html, /<h1[^>]*>Corbata tricolor<\/h1>/);
        assert.match(html, /\$9\.00 MXN/);
        assert.match(html, /Mayoreo: \$7\.00 c\/u desde 12 piezas/);
        assert.ok(!html.includes('alert(1)'), 'la descripción va sin scripts');
        assert.match(html, /class="store-container" id="storefrontProductPage"/);
      }
      if (tipo === 'categoria') {
        assert.match(html, /<h1 id="catalogSearchTitle" class="catalog-search-title">Fiesta Mexicana<\/h1>/);
        assert.match(html, /Todo para tu fiesta mexicana/);
        assert.match(html, /href="\/fiesta-mexicana\/83334-corbata-tricolor-8625553470916\.html"/);
        assert.match(html, /"@type":"CollectionPage"/);
      }
    }
  } finally { global.fetch = prev; }
});

test('el panel (/admin) sigue con todo: index.html completo', () => {
  assert.ok(INDEX.includes('id="adminDashboardWrapper"'));
  assert.ok(INDEX.includes('id="traspasoModal"'));
});
