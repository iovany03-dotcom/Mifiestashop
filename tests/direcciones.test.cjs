const test = require('node:test'), assert = require('node:assert/strict');
const { runFullSync } = require('../lib/sync-prestashop.js');

function response() {
  return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
}

test('direcciones: trae las de clientes propios, descarta las de otras tiendas/proveedores, completa nombres y guarda el avance', async () => {
  const upserts = [], estados = [], patches = [], psUrls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test')) {
      psUrls.push(u);
      if (u.includes('/api/countries?')) return json({ countries: [{ id: '144', name: [{ id: '1', value: 'México' }] }] });
      if (u.includes('/api/states?')) return json({ states: [{ id: '65', name: 'Distrito Federal' }] });
      if (u.includes('/api/addresses?')) return json({ addresses: [
        { id: '10', id_customer: '5', id_country: '144', id_state: '65', alias: 'Casa', firstname: 'Ana', lastname: 'López', address1: 'Calle 1 #2', address2: 'Col. Centro', postcode: '72000', city: 'Puebla', phone: '2221112233', phone_mobile: '', vat_number: 'XAXX010101000', other: 'Portón negro', deleted: '0', date_add: '2026-01-01 10:00:00', date_upd: '0000-00-00 00:00:00' },
        { id: '11', id_customer: '999', id_country: '144', id_state: '0', address1: 'De otra tienda', deleted: '0' },
        { id: '12', id_customer: '0', id_country: '144', address1: 'Proveedor', deleted: '0' },
        { id: '13', id_customer: '5', id_country: '144', id_state: '65', alias: 'Vieja', address1: 'Borrada', deleted: '1' }
      ] });
      return json({});
    }
    if (u.includes('/rest/v1/ps_clientes')) return json([{ id: 5 }]);
    if (u.includes('/rest/v1/ps_sync_estado')) {
      if (opts.method === 'POST') { estados.push(JSON.parse(opts.body)); return json(null); }
      return json([{ dominio: 'direcciones', last_synced_id: 164934, ultimo_resultado: 'cycle:7d6bb4d6' }]);
    }
    if (u.includes('/rest/v1/ps_direcciones') && opts.method === 'POST') { upserts.push(...JSON.parse(opts.body)); return json(null); }
    if (u.includes('/rest/v1/ps_direcciones') && opts.method === 'PATCH') { patches.push([u, JSON.parse(opts.body)]); return json(null); }
    if (u.includes('/rest/v1/ps_direcciones')) return json([{ generation: 'gen-existente' }]);
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['direcciones'] });
    assert.equal(r.direcciones.ok, true, r.direcciones.error);
    assert.equal(r.direcciones.count, 2);
    // El estado guardado es de la carga inicial ("cycle:"): recorre desde el id 1, no desde 164934.
    assert.ok(psUrls.some(x => x.includes('/api/addresses?filter[id]=[1,999999999]')), psUrls.join('\n'));
    assert.deepEqual(upserts.map(x => x.id), [10, 13]);
    const a = upserts[0];
    assert.equal(a.firstname, 'Ana'); assert.equal(a.address1, 'Calle 1 #2'); assert.equal(a.postcode, '72000');
    assert.equal(a.estado, 'Distrito Federal'); assert.equal(a.pais, 'México'); assert.equal(a.id_state, 65);
    assert.equal(a.vat_number, 'XAXX010101000'); assert.equal(a.referencia, 'Portón negro'); assert.equal(a.date_upd, null);
    assert.equal(a.deleted, false); assert.equal(a.generation, 'gen-existente');
    assert.equal(upserts[1].deleted, true);
    assert.equal(estados[0].dominio, 'direcciones'); assert.equal(estados[0].last_synced_id, 13);
    // Completa el nombre de estado/país en las filas viejas que solo tienen el id.
    assert.ok(patches.some(([u, b]) => /id_state=eq\.65&estado=is\.null/.test(u) && b.estado === 'Distrito Federal'));
    assert.ok(patches.some(([u, b]) => /id_country=eq\.144&pais=is\.null/.test(u) && b.pais === 'México'));
  } finally { global.fetch = prev; }
});

test('direcciones: si la llave de PrestaShop no tiene permiso, el error dice qué activar', async () => {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    const json = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.startsWith('https://ps.test/api/addresses')) return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    if (u.startsWith('https://ps.test')) return json({});
    return json([]);
  };
  try {
    const r = await runFullSync({ baseUrl: 'https://ps.test', apiKey: 'k', supabaseUrl: 'https://sb.test', serviceKey: 's', serviceRoleKey: 'sr', timeBudgetMs: 50000, domains: ['direcciones'] });
    assert.equal(r.direcciones.ok, false);
    assert.match(r.direcciones.error, /Webservice.*Addresses/);
  } finally { global.fetch = prev; }
});

test('api/direcciones: exige sesión y busca con la llave de servicio', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let sesion = true, urlLista = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (d, headers = {}) => ({ ok: true, json: async () => d, text: async () => '', headers: { get: k => headers[k.toLowerCase()] || null } });
    if (u.includes('rpc_check_session')) return ok(sesion);
    if (u.includes('/rest/v1/direcciones_clientes')) { urlLista = u; return ok([{ id: 1, id_customer: 5, direccion: 'Calle 1' }], { 'content-range': '0-0/57' }); }
    return ok([]);
  };
  try {
    const handler = require('../api/direcciones.js');
    let res = response();
    sesion = false;
    await handler({ method: 'POST', body: { p_admin_password: 'x' } }, res);
    assert.equal(res.code, 401);
    sesion = true; res = response();
    await handler({ method: 'POST', body: { p_admin_password: 'x', q: 'pue,bla()' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.total, 57); assert.equal(res.data.rows.length, 1);
    assert.match(urlLista, /eliminada=is\.false/);
    assert.match(urlLista, /or=\(/);
    assert.ok(!/pue,bla/.test(decodeURIComponent(urlLista)), 'la coma de la búsqueda no debe llegar al filtro');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
