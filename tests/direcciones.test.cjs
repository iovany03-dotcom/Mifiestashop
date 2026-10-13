const test = require('node:test'), assert = require('node:assert/strict');

function response() {
  return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
}

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
