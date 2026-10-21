// Rutas /api con datos privados (clientes, pedidos, ventas, carritos...): sin sesión del panel
// responden 401 y no consultan nada; con sesión válida (panel_sesion) sí. /api/productos solo
// manda el costo de compra al panel.
const test = require('node:test'), assert = require('node:assert/strict');

const PRIVADAS = ['clientes', 'pedidos', 'pedidos-online', 'carritos', 'ventas', 'ventas-productos', 'busquedas', 'proveedores', 'inventario'];

function res() {
  return { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; }, send(d) { this.data = d; return this; } };
}
const cabecera = creds => ({ 'x-mfs-sesion': Buffer.from(JSON.stringify(creds)).toString('base64') });

function mockFetch(llamadas, { sesionValida = true } = {}) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    llamadas.push(u);
    if (u.includes('/rpc/panel_sesion')) {
      const b = JSON.parse(opts.body);
      const ok = sesionValida && b.p_admin_password === 'buena';
      return { ok: true, json: async () => [{ nombre: ok ? 'Administrador' : null, es_admin: ok, permisos: [] }] };
    }
    if (u.includes('/catalogo_productos')) return { ok: true, json: async () => (u.includes('offset=0') ? [{ id: 1, name: 'Globo', price: 10, costo_compra: 4, category_id: 269 }] : []), headers: { get: () => null } };
    return { ok: true, json: async () => [], text: async () => '', headers: { get: () => '0-0/0' } };
  };
}

test('sin sesión: 401, sin consultar la base de datos y sin caché', async () => {
  const prev = { fetch: global.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  try {
    for (const nombre of PRIVADAS) {
      const llamadas = [];
      mockFetch(llamadas);
      const r = res();
      await require(`../api/${nombre}.js`)({ method: 'GET', query: {}, headers: {} }, r);
      assert.equal(r.code, 401, nombre);
      assert.deepEqual(llamadas, [], `${nombre} no debe consultar nada`);
      assert.match(String(r.headers['Cache-Control']), /no-store/, nombre);
    }
  } finally { global.fetch = prev.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key; }
});

test('contraseña equivocada: 401; correcta: entra y no se guarda en el CDN', async () => {
  const prev = { fetch: global.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  try {
    let llamadas = [];
    mockFetch(llamadas);
    let r = res();
    await require('../api/clientes.js')({ method: 'GET', query: {}, headers: cabecera({ p_admin_password: 'mala' }) }, r);
    assert.equal(r.code, 401);
    llamadas = [];
    mockFetch(llamadas);
    r = res();
    await require('../api/clientes.js')({ method: 'GET', query: {}, headers: cabecera({ p_admin_password: 'buena' }) }, r);
    assert.equal(r.code, 200);
    assert.equal(r.headers['Cache-Control'], 'private, no-store');
    assert.ok(llamadas.some(u => u.includes('/ps_clientes')));
  } finally { global.fetch = prev.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key; }
});

test('enviar-correo: la tienda solo puede mandar la suscripción', async () => {
  const prev = global.fetch, env = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: 'smtp.x', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p' });
  try {
    mockFetch([]);
    const r = res();
    await require('../api/enviar-correo.js')({ method: 'POST', query: {}, headers: {}, body: { to: 'x@ejemplo.com', tipo: 'pedido', datos: {} } }, r);
    assert.equal(r.code, 401);
  } finally { global.fetch = prev; for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } }
});

test('/api/productos: la tienda no recibe el costo de compra, el panel sí', async () => {
  const prev = { fetch: global.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  try {
    mockFetch([]);
    let r = res();
    await require('../api/productos.js')({ query: { limit: '10' }, headers: {} }, r);
    assert.equal(r.code, 200);
    assert.equal(r.data.products[0].costoCompra, undefined);
    r = res();
    await require('../api/productos.js')({ query: { limit: '10' }, headers: cabecera({ p_admin_password: 'buena' }) }, r);
    assert.equal(r.data.products[0].costoCompra, 4);
    assert.equal(r.headers['Cache-Control'], 'private, no-store');
  } finally { global.fetch = prev.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key; }
});
