const test = require('node:test'), assert = require('node:assert/strict');
const { runFullSync } = require('../lib/sync-prestashop.js');

test('pedidos_historico baja desde el pedido más viejo de ps_pedidos y marca completo', async () => {
  const upserts = [], estados = [], psUrls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      psUrls.push(u);
      if (u.includes('/api/orders?')) return json({ orders: [
        { id: '998', reference: 'A', id_customer: '5', current_state: '2', date_add: '2026-01-10 12:00:00', id_employee: '225', total_paid: '100', valid: '1', id_currency: '3' },
        { id: '997', reference: 'B', id_customer: '5', current_state: '2', date_add: '2026-01-09 12:00:00', id_employee: '0', total_paid: '50', valid: '1', id_currency: '3' }
      ] });
      if (u.includes('/api/order_details?')) return json({ order_details: [{ id_order: '998', product_id: '101', product_name: 'Globo', product_reference: 'GLB', product_quantity: '2', product_price: '50' }] });
      if (u.includes('/api/customers?')) return json({ customers: [{ id: '5', firstname: 'Ana', lastname: 'L' }] });
      return json({});
    }
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') { estados.push(JSON.parse(opts.body)); return json(null); }
      return json([]);
    }
    if (u.includes('/rest/v1/ps_pedidos') && opts.method === 'POST') { upserts.push(...JSON.parse(opts.body)); return json(null); }
    if (u.includes('/rest/v1/ps_pedidos')) return json([{ id: 1000 }]);
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['pedidos_historico'] });
    assert.equal(r.pedidos_historico.ok, true, r.pedidos_historico.error);
    assert.equal(r.pedidos_historico.count, 2);
    assert.ok(psUrls.some(u => u.includes('/api/orders?') && u.includes('filter[id]=[1,999]') && u.includes('sort=[id_DESC]')));
    assert.deepEqual(upserts.map(o => [o.id, o.id_currency, o.customer_name]), [[998, 3, 'Ana L'], [997, 3, 'Ana L']]);
    assert.deepEqual(upserts[0].items, [{ product_id: 101, name: 'Globo', sku: 'GLB', qty: 2, price: 50 }]);
    const last = estados[estados.length - 1];
    assert.equal(last.dominio, 'pedidos_historico'); assert.equal(last.last_synced_id, 997); assert.match(last.ultimo_resultado, /^completo/);
  } finally { global.fetch = prev; }
});
