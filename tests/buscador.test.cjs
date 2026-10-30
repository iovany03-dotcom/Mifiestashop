// Buscador de la tienda (index.html): las búsquedas de los botones de las páginas de contenido
// ("accesorios para bailar", "artículos al mayoreo"...) daban 0 resultados.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const trozo = (desde, hasta) => { const a = html.indexOf(desde), b = html.indexOf(hasta, a); assert.ok(a >= 0 && b > a, desde); return html.slice(a, b); };
const codigo = trozo('function normalizeEs(str){', 'function extractKeywordsEs(')
  + trozo('const BUSQUEDA_VACIAS', 'function isStorefrontSearchPageOpen()');

const PRODUCTOS = [
  { name: 'Lente batucada', sku: 'lente, batucada', catLabel: 'Batucada', cat: 'batucada' },
  { name: 'Silbato de colores', sku: 'silbato', catLabel: 'Batucada', cat: 'batucada' },
  { name: 'Sombrero de hule espuma Novio', sku: 'sombrero, boda', catLabel: 'Sombreros hule espuma', cat: 'sombreros hule espuma' },
  { name: 'Sombrero vaquero con flecos', sku: 'sombrero', catLabel: 'Sombreros', cat: 'sombreros' },
  { name: 'Letrero selfie fiesta', sku: 'letrero', catLabel: 'Decoracion', cat: 'decoracion' },
  { name: 'Corbata neón', sku: 'corbata, neon', catLabel: 'Neon Glow', cat: 'neon glow' },
  { name: 'Globo metálico dorado', sku: 'globo', catLabel: 'Globos', cat: 'globos' }
];
const ctx = vm.createContext({ liveProducts: PRODUCTOS, PRODUCTS_DATA: [] });
vm.runInContext(codigo, ctx);
const buscar = q => ctx.searchProducts(q).map(p => p.name);

test('frases de los botones de las páginas de contenido encuentran productos', () => {
  assert.deepEqual(buscar('accesorios para bailar'), ['Lente batucada', 'Silbato de colores']);
  assert.ok(buscar('accesorios para novios').includes('Sombrero de hule espuma Novio'));
  assert.equal(buscar('artículos al mayoreo').length, PRODUCTOS.length); // solo genéricas: todo el catálogo
  assert.equal(buscar('organizadores de eventos').length, PRODUCTOS.length);
  assert.ok(buscar('accesorios fluorescentes').includes('Corbata neón'));
});

test('categoría, femenino/masculino y resultados parciales', () => {
  assert.ok(buscar('batucada').includes('Silbato de colores'), 'busca en la categoría');
  assert.equal(buscar('fiesta vaquera')[0], 'Sombrero vaquero con flecos');
  const bb = buscar('batucada de boda');
  assert.ok(bb.includes('Lente batucada') && bb.includes('Sombrero de hule espuma Novio'), 'pocos exactos: agrega parciales');
  assert.deepEqual(buscar('globo dorado'), ['Globo metálico dorado']);
  assert.deepEqual(buscar('termo'), []);
});
