const test = require('node:test'), assert = require('node:assert/strict');
// Modo desconectado (default): pedidos de ps_pedidos + pedidos_online + tickets del POS propio.
delete process.env.PRESTASHOP_CONECTADO;
const handler = require('../api/ventas.js');

function call(query) {
  const res = { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ query }, res).then(() => res);
}

test('ventas suma los tickets del POS propio por sucursal y no duplica los que ya estan en PrestaShop', async () => {
  const prev = { fetch: global.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  const urls = [];
  global.fetch = async url => {
    const u = String(url); urls.push(decodeURIComponent(u));
    if (u.includes('/rest/v1/ps_pedidos')) return { ok: true, json: async () => [{ id: 1, total_paid: '100', date_add: '2026-09-26 10:00:00', id_employee: 230 }] };
    if (u.includes('/rest/v1/pedidos_online')) return { ok: true, json: async () => [] };
    if (u.includes('/rest/v1/pos_tickets')) return { ok: true, json: async () => [
      { folio: 'POS-1', total: '1379.43', almacen: 'Puebla', created_at: '2026-10-02T18:40:20Z' },
      { folio: 'POS-2', total: '500', almacen: 'Bodega Principal (Rumania)', created_at: '2026-10-02T05:30:00Z' },
      { folio: 'POS-3', total: '170', almacen: 'Querétaro', created_at: '2026-10-02T00:44:59Z' },
      { folio: 'POS-4', total: '10', almacen: 'Sucursal rara', created_at: '2026-10-02T12:00:00Z' }
    ] };
    return { ok: true, json: async () => [] };
  };
  try {
    const r = await call({ from: '2026-09-26', to: '2026-10-02' });
    assert.equal(r.code, 200);
    const tUrl = urls.find(u => u.includes('/rest/v1/pos_tickets'));
    assert.ok(tUrl.includes('ps_order_id=is.null'), 'excluye tickets que ya tienen pedido en PrestaShop');
    assert.ok(tUrl.includes('created_at=gte.2026-09-26T00:00:00-06:00') && tUrl.includes('created_at=lte.2026-10-02T23:59:59-06:00'), 'rango en hora de Mexico');
    const by = Object.fromEntries(r.data.byStore.map(s => [s.store, s]));
    assert.deepEqual([by['Puebla'].revenue, by['Puebla'].orders], [1479.43, 2]);
    assert.deepEqual([by['CDMX Rumania'].revenue, by['CDMX Rumania'].orders], [500, 1]);
    assert.deepEqual([by['Querétaro'].revenue, by['Querétaro'].orders], [170, 1]);
    assert.deepEqual([by['Otros'].revenue, by['Otros'].orders], [10, 1]);
    assert.equal(r.data.orders, 5);
    assert.equal(Math.round(r.data.byStore.reduce((s, x) => s + x.revenue, 0) * 100) / 100, r.data.revenue);
    // 2026-10-02T00:44:59Z y 05:30Z son del 1 de octubre en la Ciudad de Mexico (UTC-6)
    const dias = Object.fromEntries(r.data.breakdown.map(b => [b.label, b.orders]));
    assert.equal(dias['2026-10-01'], 2); assert.equal(dias['2026-10-02'], 2); assert.equal(dias['2026-09-26'], 1);
  } finally {
    global.fetch = prev.fetch;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
  }
});
