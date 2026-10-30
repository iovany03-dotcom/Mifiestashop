const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MP = path.join(__dirname, '../lib/mp-pago.js');
const venc = () => { delete require.cache[require.resolve('../lib/pedido-vencimiento.js')]; return require('../lib/pedido-vencimiento.js'); };

test('vigencia por defecto 72 h y configurable por env', () => {
  delete process.env.PEDIDO_VIGENCIA_HORAS; delete process.env.PEDIDO_VIGENCIA_PENDIENTE_HORAS;
  assert.equal(venc().vigenciaHoras(), 72);
  assert.equal(venc().vigenciaPendientePagoHoras(), 72);
  process.env.PEDIDO_VIGENCIA_HORAS = '6';
  assert.equal(venc().vigenciaHoras(), 6);
  delete process.env.PEDIDO_VIGENCIA_HORAS;
});

test('crear-pedido ya no manda push de "Nuevo pedido"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../api/crear-pedido.js'), 'utf8');
  assert.ok(!/enviarPushAdmins/.test(src));
});

test('cancela el pedido vencido, regresa stock y registra historial', async () => {
  const llamadas = [];
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const m = opts.method || 'GET';
    llamadas.push(m + ' ' + url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.includes('mercadopago.com')) return ok({ results: [] });
    if (url.includes('pos_stock_moves') && m === 'GET') return ok([{ id_product: 'A', almacen: 'X', qty: -2 }]);
    if (url.includes('pedidos_online') && m === 'PATCH') return ok(url.includes('status=in') ? [{ folio: 'WEB-1' }] : []);
    if (url.includes('pedidos_online') && url.includes('limit=')) return ok([{ folio: 'WEB-1', status: 'Pendiente' }]);
    if (url.includes('pedidos_online')) return ok([{ status: 'Pendiente' }]);
    return ok([]);
  };
  try {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    const r = await venc().vencerPedidosSinPago({ accessToken: 't', serviceRoleKey: 'k' });
    assert.equal(r.cancelados, 1);
    assert.equal(r.resultados[0].piezasRegresadas, 2);
    assert.ok(llamadas.some(l => l.startsWith('PATCH') && l.includes('WEB-1')));
    assert.ok(llamadas.some(l => l.startsWith('POST') && l.includes('pos_stock_moves')));
  } finally { global.fetch = orig; }
});
