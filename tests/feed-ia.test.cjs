// Visibilidad en Google Shopping y en asistentes de IA: catálogo para Merchant Center
// (api/feed-google.js), /llms.txt (api/llms.js) e IndexNow (lib/indexnow.js).
const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
const feed = require('../api/feed-google.js');

const PROD = { id: 83389, name: 'Bombín neón', link_rewrite: 'bombin-neon', barcode: '9571834896571', category_id: 284, price: 6, images: ['https://x.supabase.co/a.webp', 'https://x.supabase.co/b.webp'], description: '<p>Bombín de PVC & neón</p><script>x</script>' };
const CAT = { id: 284, name: 'Neon Glow', link_rewrite: 'neon-glow', active: true };

test('GTIN: solo códigos reales (dígito verificador correcto y que no sean internos con prefijo 2)', () => {
  assert.equal(feed.gtinReal('7501055363278'), '7501055363278');
  assert.equal(feed.gtinReal('7501055363279'), null);   // verificador mal
  assert.equal(feed.gtinReal('2896034461785'), null);   // interno
  assert.equal(feed.gtinReal('123'), null);
});

test('feed: un producto con liga canónica, fotos, precio, existencias y sin GTIN inventado', () => {
  const x = feed.item(PROD, null, CAT, 12);
  assert.match(x, /<g:id>83389<\/g:id>/);
  assert.match(x, /<g:link>https:\/\/www\.mifiestashop\.com\/neon-glow\/83389-bombin-neon-9571834896571\.html<\/g:link>/);
  assert.match(x, /<g:image_link>https:\/\/x\.supabase\.co\/a\.webp<\/g:image_link><g:additional_image_link>https:\/\/x\.supabase\.co\/b\.webp/);
  assert.match(x, /<g:price>6\.00 MXN<\/g:price>/);
  assert.match(x, /<g:availability>in_stock<\/g:availability>/);
  assert.match(x, /<g:description>Bombín de PVC &amp; neón<\/g:description>/);
  assert.ok(!/<script|neón x/.test(x), 'sin el código de la descripción');
  assert.match(x, /<g:identifier_exists>no<\/g:identifier_exists>/); // 9571834896571 no cuadra el verificador
  assert.ok(!x.includes('<g:shipping>'), 'abajo de $1,500 el envío se configura en Merchant Center');
  assert.match(x, /<g:product_type>Artículos para fiesta &gt; Neon Glow<\/g:product_type>/);
  assert.match(feed.item(PROD, null, CAT, 0), /out_of_stock/);
  assert.match(feed.item(PROD, null, CAT, undefined), /in_stock/, 'sin registro de existencias = disponible, como en la tienda');
  assert.match(feed.item({ ...PROD, price: 1800 }, null, CAT, 3), /<g:shipping><g:country>MX<\/g:country><g:price>0\.00 MXN<\/g:price><\/g:shipping>/);
  assert.equal(feed.item({ ...PROD, price: 0 }, null, CAT, 3), '', 'sin precio no se publica');
  assert.equal(feed.item({ ...PROD, images: [] }, null, CAT, 3), '', 'sin foto no se publica');
});

test('feed completo: RSS válido con existencias sumadas de todas las sucursales', async () => {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    const ok = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('/catalogo_productos')) return ok([PROD, { ...PROD, id: 2, link_rewrite: 'otro', barcode: null }]);
    if (u.includes('/productos_migrados')) return ok([]);
    if (u.includes('/ps_categorias')) return ok([CAT]);
    if (u.includes('/rpc/stock_publico')) return ok([{ id_product: 83389, id_warehouse: 53, cantidad: 0 }, { id_product: 83389, id_warehouse: 56, cantidad: -2 }]);
    return ok([]);
  };
  try {
    const { total, xml } = await feed.generarFeed();
    assert.equal(total, 2);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0" xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0">/);
    assert.match(xml, /<g:id>83389<\/g:id>[\s\S]*?<g:availability>out_of_stock/);  // 0 y una sucursal en negativo = agotado
    assert.match(xml, /<g:id>2<\/g:id>[\s\S]*?<g:availability>in_stock/);          // sin registro
  } finally { global.fetch = prev; }
});

test('llms.txt: categorías y más vendidos con ligas reales; sin políticas inventadas', async () => {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    const ok = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('/ps_categorias')) return ok([CAT, { id: 266, name: 'Productos', link_rewrite: 'productos', active: true }]);
    if (u.includes('/catalogo_productos')) return ok([{ ...PROD, price_mayoreo: 4, price_mayoreo_desde_unidades: 12, meta_description: 'Bombín que brilla con luz UV.' }]);
    if (u.includes('ventas_producto_mes')) return ok([{ product_id: 83389, units: 50 }]);
    return ok([]);
  };
  try {
    const t = await require('../api/llms.js').generar();
    assert.match(t, /^# Mi Fiestashop\n\n> /);
    assert.match(t, /- \[Neon Glow\]\(https:\/\/www\.mifiestashop\.com\/284-neon-glow\): 1 productos\./);
    assert.ok(!t.includes('[Productos]'), 'las categorías genéricas no se listan');
    assert.match(t, /- \[Bombín neón\]\(https:\/\/www\.mifiestashop\.com\/neon-glow\/83389-bombin-neon-9571834896571\.html\): \$6\.00 MXN, mayoreo \$4\.00 MXN desde 12 piezas\. Bombín que brilla con luz UV\./);
    assert.match(t, /politica-de-devolucion-mi-fiesta-shop/);
  } finally { global.fetch = prev; }
});

test('IndexNow: solo URLs del sitio, sin repetir, con la llave publicada', async () => {
  const prev = global.fetch;
  let cuerpo = null;
  global.fetch = async (url, opts) => { cuerpo = { url: String(url), body: JSON.parse(opts.body) }; return { status: 202, text: async () => '' }; };
  try {
    const { LLAVE, avisar } = require('../lib/indexnow.js');
    const fs = require('fs'), path = require('path');
    assert.equal(fs.readFileSync(path.join(__dirname, '..', `${LLAVE}.txt`), 'utf8').trim(), LLAVE, 'el archivo de la llave existe y coincide');
    const r = await avisar(['https://www.mifiestashop.com/a', 'https://www.mifiestashop.com/a', 'https://otro.com/x']);
    assert.equal(r.enviadas, 1);
    assert.equal(cuerpo.url, 'https://api.indexnow.org/indexnow');
    assert.deepEqual(cuerpo.body.urlList, ['https://www.mifiestashop.com/a']);
    assert.equal(cuerpo.body.keyLocation, `https://www.mifiestashop.com/${LLAVE}.txt`);
  } finally { global.fetch = prev; }
});
