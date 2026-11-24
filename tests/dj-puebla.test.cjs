// Página para DJs y animadores en Puebla (api/dj-puebla.js): precios vivos por pieza y mayoreo.
const test = require('node:test'), assert = require('node:assert/strict');
const dj = require('../api/dj-puebla.js');

test('mayoreo: solo si es menor que el precio por pieza y aplica desde 2+ piezas; calcula el ahorro', () => {
  assert.deepEqual(dj.mayoreo({ price: 15, price_mayoreo: 13.3, price_mayoreo_desde_unidades: 12 }), { precio: 13.3, desde: 12, ahorro: 11 });
  assert.equal(dj.mayoreo({ price: 2, price_mayoreo: null, price_mayoreo_desde_unidades: null }), null);
  assert.equal(dj.mayoreo({ price: 10, price_mayoreo: 12, price_mayoreo_desde_unidades: 3 }), null);
});

test('página: catálogo con foto, precios del catálogo, ligas canónicas, un H1, FAQ y datos para Google', () => {
  const porId = new Map([[84529, { id: 84529, name: 'Lente luminoso led', price: 15, price_mayoreo: 13.3, price_mayoreo_desde_unidades: 12, images: ['https://x.supabase.co/a.webp'], url: '/productos/84529-lente-luminoso-led-.html' }],
    [10790464092173, { id: 10790464092173, name: 'Promo Batucada VIP', price: 1700, url: '/promociones/x.html' }]]);
  const html = dj.pagina(porId);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<a class="dj-card" href="\/productos\/84529-lente-luminoso-led-\.html">\s*<span class="dj-foto"><img src="https:\/\/x\.supabase\.co\/a\.webp" alt="Lente luminoso led" loading="lazy"/);
  assert.match(html, /<span class="dj-precio">\$15\.00 <small>por pieza<\/small><\/span>\s*<span class="dj-mayoreo">\$13\.30 desde 12 pzas <b>−11%<\/b><\/span>/);
  assert.match(html, /<span class="dj-nombre">Promo Batucada VIP<\/span>\s*<span class="dj-precio">\$1,700\.00/);
  assert.match(html, /<span class="dj-foto"><\/span>/, 'sin foto no se rompe la tarjeta');
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.mifiestashop\.com\/articulos-para-dj-puebla">/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
  assert.ok(ld['@graph'].some(x => x['@type'] === 'FAQPage'));
  assert.ok(!/<section class="wrap dj-grupo"><h2>Cyalume/.test(html), 'un grupo sin productos no se muestra');
});

// Cupón DJPUEBLA10: 10% en la segunda compra (lib/cupones.js revisarRecompra).
test('cupón de segunda compra: pide un pedido pagado previo y se usa una sola vez por correo', async () => {
  const { revisarRecompra } = require('../lib/cupones.js');
  const cupon = { codigo: 'DJPUEBLA10', solo_recompra: true, un_uso_por_cliente: true };
  const prev = global.fetch;
  let pedidos = [];
  let url = '';
  global.fetch = async (u) => { url = decodeURIComponent(String(u)); return { ok: true, json: async () => pedidos }; };
  try {
    assert.match((await revisarRecompra('k', cupon, '')).error, /correo/);
    pedidos = [];
    assert.match((await revisarRecompra('k', cupon, 'dj@x.mx')).error, /segunda compra/);
    assert.match(url, /customer_email=ilike\.dj@x\.mx&status=in\.\("Pago aceptado","Pagado"/);
    pedidos = [{ cupon_codigo: null }];
    assert.equal((await revisarRecompra('k', cupon, 'dj@x.mx')).ok, true);
    pedidos = [{ cupon_codigo: null }, { cupon_codigo: 'djpuebla10' }];
    assert.match((await revisarRecompra('k', cupon, 'dj@x.mx')).error, /Ya usaste/);
    assert.equal((await revisarRecompra('k', { codigo: 'OTRO' }, '')).ok, true, 'los cupones normales no cambian');
  } finally { global.fetch = prev; }
});
