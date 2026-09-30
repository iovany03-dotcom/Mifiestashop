const test = require('node:test'), assert = require('node:assert/strict');
const { toProduct } = require('../lib/productos-supabase.js');

test('toProduct: un producto manual con link_rewrite sí recibe url propia (no se va al modal)', () => {
  const p = toProduct(
    { id: 9000000000123, source: 'manual', name: 'Globo Kinder', sku: 'MAN-1', price: 20, link_rewrite: 'globo-kinder' },
    null, {}, 'https://mifiestashop.com'
  );
  assert.equal(p.url, '/9000000000123-globo-kinder.html');
});

test('toProduct: un producto manual sin link_rewrite se queda sin url (cae al modal, no un link roto)', () => {
  const p = toProduct(
    { id: 9000000000124, source: 'manual', name: 'Otro producto', sku: 'MAN-2', price: 20, link_rewrite: null },
    null, {}, 'https://mifiestashop.com'
  );
  assert.equal(p.url, undefined);
});

test('toProduct: un producto de PrestaShop conserva su comportamiento (fallback a index.php si falta link_rewrite)', () => {
  const p = toProduct(
    { id: 84650, source: 'prestashop', name: 'Pantuflas', sku: 'BND-1', price: 42, link_rewrite: null },
    null, {}, 'https://mifiestashop.com'
  );
  assert.equal(p.url, 'https://mifiestashop.com/index.php?id_product=84650&controller=product');
});
