// Página para DJs y animadores en Puebla (api/dj-puebla.js): precios vivos por pieza y mayoreo.
const test = require('node:test'), assert = require('node:assert/strict');
const dj = require('../api/dj-puebla.js');

test('mayoreo: solo si es menor que el precio por pieza y aplica desde 2+ piezas; calcula el ahorro', () => {
  assert.deepEqual(dj.mayoreo({ price: 15, price_mayoreo: 13.3, price_mayoreo_desde_unidades: 12 }), { precio: 13.3, desde: 12, ahorro: 11 });
  assert.equal(dj.mayoreo({ price: 2, price_mayoreo: null, price_mayoreo_desde_unidades: null }), null);
  assert.equal(dj.mayoreo({ price: 10, price_mayoreo: 12, price_mayoreo_desde_unidades: 3 }), null);
});

test('página: tabla con precios del catálogo, ligas canónicas, un H1, FAQ y datos para Google', () => {
  const porId = new Map([[84529, { id: 84529, name: 'Lente luminoso led', price: 15, price_mayoreo: 13.3, price_mayoreo_desde_unidades: 12, url: '/productos/84529-lente-luminoso-led-.html' }],
    [10790464092173, { id: 10790464092173, name: 'Promo Batucada VIP', price: 1700, url: '/promociones/x.html' }]]);
  const html = dj.pagina(porId);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<a href="\/productos\/84529-lente-luminoso-led-\.html">Lente luminoso led<\/a><\/td><td>\$15\.00<\/td><td><b>\$13\.30<\/b>/);
  assert.match(html, /Promo Batucada VIP<span>\$1,700\.00<\/span>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.mifiestashop\.com\/articulos-para-dj-puebla">/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
  assert.ok(ld['@graph'].some(x => x['@type'] === 'FAQPage'));
  assert.ok(!/<section class="wrap dj-grupo"><h2>Cyalume/.test(html), 'un grupo sin productos no se muestra');
});
