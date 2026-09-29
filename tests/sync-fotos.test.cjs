const test = require('node:test'), assert = require('node:assert/strict');
const { runFullSync } = require('../lib/sync-prestashop.js');

test('sync fotos: migra la foto de un producto INACTIVO también (no solo activos)', async () => {
  const seenSelectUrls = [];
  let patched = null;
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '', arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => 'image/jpeg' } });
    if (u.startsWith('https://ps.test')) {
      // descarga de la imagen real desde PrestaShop
      return json({});
    }
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') return json(null);
      return json([]);
    }
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'PATCH') {
      patched = JSON.parse(opts.body);
      return json(null);
    }
    if (u.includes('/rest/v1/catalogo_productos')) {
      seenSelectUrls.push(u);
      // Un solo producto desactivado, con legacy_image_url y sin images todavía.
      return json([{ id: 84601, legacy_image_url: 'https://ps.test/api/images/products/84601/1' }]);
    }
    if (u.includes('/storage/v1/object/')) return json(null);
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['fotos'] });
    assert.equal(r.fotos.ok, true, r.fotos.error);
    assert.equal(r.fotos.count, 1);
    // La consulta que trae los productos pendientes de foto ya NO filtra
    // por active=eq.true — antes un producto desactivado nunca llegaba
    // aquí y se quedaba sin su foto migrada a Storage para siempre.
    assert.ok(seenSelectUrls.some(u => u.includes('images=is.null') && !u.includes('active=eq.true')));
    assert.ok(patched && Array.isArray(patched.images) && patched.images[0].includes('84601'));
  } finally { global.fetch = prev; }
});
