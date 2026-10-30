const test = require('node:test');
const assert = require('node:assert');
const { descontarStock, bodegaDePedido } = require('../lib/pedido-stock.js');

test('bodega: recoger en tienda usa la sucursal; envío usa Rumania', () => {
  delete process.env.BODEGA_PEDIDOS_WEB;
  assert.equal(bodegaDePedido('Recoger en tienda - Puebla'), 'puebla');
  assert.equal(bodegaDePedido('Recoger en tienda - Querétaro'), 'queretaro');
  assert.equal(bodegaDePedido('Estafeta'), 'rumania');
  process.env.BODEGA_PEDIDOS_WEB = 'puebla';
  assert.equal(bodegaDePedido('DHL'), 'puebla');
  delete process.env.BODEGA_PEDIDOS_WEB;
});

test('descuenta una vez por folio y agrupa productos repetidos', async () => {
  const posts = [];
  let previos = [];
  const api = async (p, o = {}) => { if (o.method === 'POST') { posts.push(JSON.parse(o.body)); return null; } return previos; };
  const n = await descontarStock(api, 'WEB-1', [{ id: 5, qty: 2 }, { id: 5, qty: 1 }, { id: 7, qty: 4 }, { id: 0, qty: 9 }], 'DHL', 'x');
  assert.equal(n, 7);
  assert.deepEqual(posts[0].map(m => [m.id_product, m.qty, m.almacen]), [[5, -3, 'rumania'], [7, -4, 'rumania']]);
  previos = [{ id: 1 }];
  assert.equal(await descontarStock(api, 'WEB-1', [{ id: 5, qty: 2 }], 'DHL'), 0);
  assert.equal(posts.length, 1);
});
