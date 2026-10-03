const test = require('node:test'), assert = require('node:assert/strict');
const est = require('../lib/estimado-ventas.js');

function response() {
  return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
}

test('guardar-producto: guarda código de proveedor y hasta 3 competidores (sanitizados) en producto_privado y fecha si cambió el costo', async () => {
  let privado = null, catalogo = null;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('/rpc/rpc_check_session')) return ok(true);
    if (u.includes('/rest/v1/producto_privado') && opts.method === 'POST') { privado = JSON.parse(opts.body)[0]; return ok(null); }
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'POST') { catalogo = JSON.parse(opts.body)[0]; return ok(null); }
    if (u.includes('/rest/v1/catalogo_productos?id=eq.83101&select=costo_compra')) return ok([{ costo_compra: '7.5' }]);
    if (u.includes('/rest/v1/catalogo_productos')) return ok([{ source: 'prestashop', link_rewrite: 'x' }]);
    return ok({});
  };
  try {
    const res = response();
    await require('../api/guardar-producto.js')({ method: 'POST', body: { p_admin_password: 'x', producto: {
      id: 83101, sku: 'S', name: 'Vela', price: 10, costoCompra: 8,
      codigoProveedor: '  PRV-1 ',
      competencia: [
        { nombre: 'Mercado Libre', precio: '12.345', enlace: 'https://ml.com/x' },
        { nombre: '', precio: null, enlace: '' },
        { nombre: 'Amazon', precio: 11, enlace: 'javascript:alert(1)' },
        { nombre: 'Otro', precio: 9, enlace: 'http://otro.com' },
        { nombre: 'Cuarto', precio: 8, enlace: 'https://cuarto.com' }
      ]
    } } }, res);
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    assert.equal(res.data.aviso, undefined);
    assert.equal(privado.id, 83101);
    assert.equal(privado.codigo_proveedor, 'PRV-1');
    assert.deepEqual(privado.competencia, [
      { nombre: 'Mercado Libre', precio: 12.35, enlace: 'https://ml.com/x' },
      { nombre: 'Amazon', precio: 11, enlace: '' }
    ]);
    assert.ok(privado.costo_compra_actualizado_at, 'el costo cambió (7.5 -> 8): se fija la fecha');
    // lo privado nunca viaja a catalogo_productos (legible con la llave pública)
    for (const k of ['codigo_proveedor', 'competencia', 'costoCompraActualizado']) assert.equal(k in catalogo, false);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('guardar-producto: si el costo no cambia no mueve la fecha, y un cliente viejo (sin esos campos) no pisa lo guardado', async () => {
  let privado = null;
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('/rpc/rpc_check_session')) return ok(true);
    if (u.includes('/rest/v1/producto_privado') && opts.method === 'POST') { privado = JSON.parse(opts.body)[0]; return ok(null); }
    if (u.includes('select=costo_compra')) return ok([{ costo_compra: '8' }]);
    return ok({});
  };
  try {
    let res = response();
    await require('../api/guardar-producto.js')({ method: 'POST', body: { p_admin_password: 'x', producto: { id: 83101, sku: 'S', name: 'Vela', price: 10, costoCompra: 8, codigoProveedor: 'A' } } }, res);
    assert.equal(res.data.ok, true);
    assert.equal(privado.codigo_proveedor, 'A');
    assert.equal('costo_compra_actualizado_at' in privado, false);
    privado = null; res = response();
    await require('../api/guardar-producto.js')({ method: 'POST', body: { p_admin_password: 'x', producto: { id: 83101, sku: 'S', name: 'Vela', price: 10, costoCompra: 8 } } }, res);
    assert.equal(privado, null, 'sin esos campos y sin cambio de costo no se escribe producto_privado');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('estimado-ventas: promedio real de meses cerrados (sin el mes parcial inicial) y por similitud para productos sin historial', () => {
  const hoy = new Date(Date.UTC(2026, 9, 3));
  const { porProducto, primerMes } = est.agregarVentas([
    { product_id: 1, month: '2026-03', units: 100 }, // mes parcial: se descarta
    { product_id: 1, month: '2026-04', units: 12 }, { product_id: 1, month: '2026-06', units: 18 }, { product_id: 1, month: '2026-09', units: 30 },
    { product_id: 1, month: '2026-10', units: 4 }
  ]);
  const real = est.estimarReal(porProducto.get('1'), primerMes, hoy);
  assert.equal(real.meses, 6); assert.equal(real.unidades, 60); assert.equal(real.promedio, 10);
  assert.equal(real.mesesConVenta, 3); assert.equal(real.mesActual.unidades, 4);
  const sim = est.estimarPorSimilares({ name: 'Globo calabaza murciélago halloween', categoryLabel: 'Globos', price: 25 }, [
    { id: 9, name: 'Globo calabaza halloween', categoryLabel: 'Globos', price: 23, promedio: 40 },
    { id: 11, name: 'Globo murcielago negro halloween', categoryLabel: 'Globos', price: 28, promedio: 20 },
    { id: 10, name: 'Vela de bengala', categoryLabel: 'Velas', price: 10, promedio: 200 }
  ]);
  assert.equal(sim.promedio, 30); assert.equal(sim.similares.length, 2);
  assert.equal(est.estimarPorSimilares({ name: 'Cosa rara única', price: 5 }, [{ id: 10, name: 'Vela de bengala', promedio: 200 }]), null);
});

test('api/producto-estimado: exige sesión y usa similares cuando el producto casi no se ha vendido', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let sesion = true;
  const hoy = new Date();
  const mesesAtras = n => { const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(sesion);
    if (u.includes('ps_ventas_producto_mes')) return ok([6, 5, 4, 3, 2, 1].flatMap(n => [{ product_id: 9, month: mesesAtras(n), units: 40 }]).concat([{ product_id: 5, month: mesesAtras(9), units: 1 }]));
    if (u.includes('pos_ventas_producto_mes')) return ok([]);
    if (u.includes('catalogo_productos')) return ok([
      { id: 9, name: 'Globo calabaza halloween', category_label: 'Globos', price: 23 },
      { id: 77, name: 'Globo calabaza con gato', category_label: 'Globos', price: 25 }]);
    if (u.includes('ps_stock')) return ok([{ quantity: '60', id_warehouse: 53 }]);
    if (u.includes('pos_stock_moves')) return ok([{ qty: '-10' }]);
    return ok([]);
  };
  try {
    const handler = require('../api/producto-estimado.js');
    let res = response(); sesion = false;
    await handler({ method: 'POST', body: { p_admin_password: 'x' } }, res);
    assert.equal(res.code, 401);
    sesion = true; res = response();
    await handler({ method: 'POST', body: { p_admin_password: 'x', id: 77 } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.fuente, 'similares');
    assert.equal(res.data.estimado.promedio, 40);
    assert.equal(res.data.stock, 50);
    assert.equal(res.data.mesesDeStock, 1.3);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
