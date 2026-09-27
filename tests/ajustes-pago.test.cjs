const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const handler = require('../api/ajustes-pago.js');
const correo = require('../lib/correo.js');

function call(body) {
  const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  return handler({ method: 'POST', body }, res).then(() => res);
}

test('ajustes-pago: sin sesión no guarda nada', async () => {
  const urls = [];
  global.fetch = async url => { urls.push(String(url)); return { ok: true, json: async () => false }; };
  const r = await call({ p_admin_password: 'mala', datos: { clabe: '012180001191093312' } });
  assert.equal(r.code, 401);
  assert.ok(urls.every(u => !u.includes('ajustes_pago')));
});

test('ajustes-pago: con sesión guarda la fila única y valida la CLABE', async () => {
  let saved = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('rpc_check_session')) return { ok: true, json: async () => ({ role: 'admin' }) };
    if (u.includes('ajustes_pago')) { saved = JSON.parse(opts.body); return { ok: true, json: async () => [saved], text: async () => '' }; }
    return { ok: false, json: async () => ({}) };
  };
  let r = await call({ p_admin_password: 'buena', datos: { clabe: '123' } });
  assert.equal(r.code, 400);
  r = await call({ p_admin_password: 'buena', datos: { leyenda: 'Cuenta para reservaciones', titular: 'SERVICIOS Y ARTÍCULOS PARA EL ENTRETENIMIENTO SAS', banco: 'Bancomer', cuenta: '0119 109331', clabe: '012180001191093312' } });
  assert.equal(r.code, 200);
  assert.equal(saved.id, 1); assert.equal(saved.transferencia_cuenta, '0119109331'); assert.equal(saved.transferencia_clabe, '012180001191093312'); assert.equal(saved.transferencia_activa, true);
});

test('correo de pedido: los datos bancarios los pone el servidor, no el navegador', () => {
  // enviar-correo.js descarta cualquier "transferencia" que mande el navegador
  // y la vuelve a leer de ajustes_pago con loadTransferencia().
  const src = require('fs').readFileSync(require('path').join(__dirname, '../api/enviar-correo.js'), 'utf8');
  assert.match(src, /delete datosEnvio\.transferencia/);
  assert.match(src, /await loadTransferencia\(\)/);
  const html = correo.TEMPLATES.pedido({ pedidoId: 'WEB-1', total: 100, transferencia: { titular: 'X', banco: 'Bancomer', cuenta: '0119109331', clabe: '012180001191093312' } }).html;
  assert.match(html, /012180001191093312/); assert.match(html, /Pedido WEB-1/);
  assert.doesNotMatch(correo.TEMPLATES.pedido({ pedidoId: 'WEB-1', total: 100 }).html, /Datos para tu transferencia/);
});
