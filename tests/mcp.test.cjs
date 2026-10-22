const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/mcp.js');
const KEY = 'mfs_live_' + 'a'.repeat(48);

function response() {
  return { code: 0, body: undefined, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
}
function mock(scopes, { creado } = {}) {
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    llamadas.push({ u, opts });
    const json = d => ({ ok: true, status: 200, json: async () => d, text: async () => '' });
    if (u.includes('/rest/v1/api_keys?key_hash')) return json(scopes ? [{ id: 1, nombre: 'test', scopes, activo: true }] : []);
    if (u.includes('/rest/v1/api_keys?id=')) return json(null);
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'POST') { const row = JSON.parse(opts.body); if (creado) creado.row = row; return json([row]); }
    if (u.includes('/rest/v1/catalogo_productos')) return json([{ id: 5, name: 'Collar hawaiano', price: 7, active: true, images: [] }]);
    return json([]);
  };
  return llamadas;
}
async function llamar(body, { query = {}, auth = `Bearer ${KEY}` } = {}) {
  const res = response();
  await handler({ method: 'POST', query, headers: auth ? { authorization: auth } : {}, body }, res);
  return res;
}

test('sin llave válida responde 401', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  mock(null);
  try {
    const res = await llamar({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.code, 401);
  } finally { global.fetch = prev; }
});

test('initialize y tools/list filtrado por permisos (llave en la URL)', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  mock(['products:read']);
  try {
    let res = await llamar({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { query: { key: KEY }, auth: null });
    assert.equal(res.code, 200);
    assert.equal(res.body.result.protocolVersion, '2025-03-26');
    assert.ok(res.body.result.capabilities.tools);
    res = await llamar({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.code, 202);
    res = await llamar({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const nombres = res.body.result.tools.map(t => t.name);
    assert.deepEqual(nombres.sort(), ['buscar_productos', 'ver_producto']);
    res = await llamar({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crear_producto', arguments: { nombre: 'x', precio: 1 } } });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /products:write/);
  } finally { global.fetch = prev; }
});

test('crear_producto queda oculto por defecto y limpia la descripción', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const creado = {};
  mock(['products:write'], { creado });
  try {
    const res = await llamar({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'crear_producto', arguments: { nombre: 'Collar hawaiano neón', precio: 7.5, descripcion: '<p>Bonito</p><script>x</script>' } } });
    assert.equal(res.body.result.isError, undefined);
    assert.equal(creado.row.active, false);
    assert.equal(creado.row.price, 7.5);
    assert.equal(creado.row.description, '<p>Bonito</p>');
    assert.equal(creado.row.link_rewrite, 'collar-hawaiano-neon');
    assert.equal(res.body.result.structuredContent.visible_en_tienda, false);
  } finally { global.fetch = prev; }
});

test('buscar_productos', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const ll = mock(['*']);
  try {
    const res = await llamar({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'buscar_productos', arguments: { texto: 'collar' } } });
    assert.equal(res.body.result.structuredContent.productos[0].nombre, 'Collar hawaiano');
    assert.ok(ll.some(c => c.u.includes('name.ilike.*collar*') && c.u.includes('active=eq.true')));
  } finally { global.fetch = prev; }
});

// PNG de 1×1 válido.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function mockFotos(scopes) {
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    llamadas.push({ u, opts });
    const json = d => ({ ok: true, status: 200, json: async () => d, text: async () => '' });
    if (u.includes('/rest/v1/api_keys?key_hash')) return json([{ id: 1, nombre: 'test', scopes, activo: true }]);
    if (u.includes('/rest/v1/api_keys?id=')) return json(null);
    if (u.includes('/storage/v1/object/assets/')) return json({ Key: 'ok' });
    if (u.includes('/rest/v1/catalogo_productos') && opts.method === 'PATCH') return json([{ id: 83289, name: 'Antifaz', price: 25, ...JSON.parse(opts.body) }]);
    if (u.includes('/rest/v1/catalogo_productos')) return json([{ id: 83289, images: ['https://x/a1.jpg', 'https://x/a2.jpg'] }]);
    if (u.includes('/rest/v1/productos_migrados') && opts.method === 'PATCH') return json(null);
    if (u.includes('/rest/v1/productos_migrados')) return json([{ images: ['https://x/a1.jpg', 'https://x/a2.jpg'] }]);
    return json([]);
  };
  return llamadas;
}

test('cambiar_foto_producto reemplaza la primera foto con una imagen en base64 y conserva la segunda', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const llamadas = mockFotos(['products:write']);
  try {
    const lista = await llamar({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const t = lista.body.result.tools.find(x => x.name === 'cambiar_foto_producto');
    assert.deepEqual(t._meta['openai/fileParams'], ['imagen']);
    const res = await llamar({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cambiar_foto_producto', arguments: { id: 83289, posicion: 1, imagen_base64: PNG } } });
    assert.ok(!res.body.result.isError, res.body.result.content[0].text);
    const fotos = res.body.result.structuredContent.fotos;
    assert.equal(fotos.length, 2);
    assert.match(fotos[0], /storage\/v1\/object\/public\/assets\/productos\/.+\.png$/);
    assert.equal(fotos[1], 'https://x/a2.jpg');
    const subida = llamadas.find(l => l.u.includes('/storage/v1/object/assets/'));
    assert.equal(subida.opts.headers['Content-Type'], 'image/png');
    assert.ok(llamadas.some(l => l.u.includes('/rest/v1/productos_migrados') && l.opts.method === 'PATCH'));
  } finally { global.fetch = prev; }
});

test('subir_imagen acepta data URL y rechaza lo que no es imagen', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  mockFotos(['products:write']);
  try {
    let res = await llamar({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'subir_imagen', arguments: { imagen_base64: 'data:image/png;base64,' + PNG } } });
    assert.match(res.body.result.structuredContent.url, /^https:\/\/.+\.png$/);
    res = await llamar({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'subir_imagen', arguments: { imagen_base64: Buffer.from('<html>hola</html>').toString('base64') } } });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /no es una imagen/);
    res = await llamar({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'subir_imagen', arguments: { imagen_url: '/mnt/data/foto.png' } } });
    assert.equal(res.body.result.isError, true);
  } finally { global.fetch = prev; }
});

// ---------- Inventario ----------
function mockInventario(scopes, { stock = {}, documento = null } = {}) {
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    llamadas.push({ u, opts });
    const json = d => ({ ok: true, status: 200, json: async () => d, text: async () => '' });
    if (u.includes('/rest/v1/api_keys?key_hash')) return json([{ id: 1, nombre: 'ChatGPT', scopes, activo: true }]);
    if (u.includes('/rest/v1/api_keys?id=')) return json(null);
    if (u.includes('/rpc/stock_totales')) {
      const ids = JSON.parse(opts.body).p_ids;
      return json(ids.flatMap(id => Object.entries(stock[id] || {}).map(([almacen, cantidad]) => ({ id_product: id, almacen, cantidad }))));
    }
    if (u.includes('/rpc/mov_doc_save_core')) {
      const b = JSON.parse(opts.body);
      if (b.p_tipo === 'entrada' && !/^(devolucion|correccion|conteo):/.test(b.p_motivo || '')) return { ok: false, status: 400, json: async () => ({}), text: async () => '{"message":"INGRESO NO PERMITIDO. Para registrar mercancía..."}' };
      return json({ id: 9, folio: 'SAL-261022-0001', tipo: b.p_tipo, estado: 'borrador', origen: b.p_origen, destino: b.p_destino, motivo: b.p_motivo, items: b.p_items, creado_por: b.p_por });
    }
    if (u.includes('/rpc/mov_doc_approve_core')) { const b = JSON.parse(opts.body); return json({ ...documento, estado: 'aprobado', aprobado_por: b.p_por }); }
    if (u.includes('/rest/v1/mov_documentos?select=*&folio=')) return json(documento ? [documento] : []);
    if (u.includes('/rest/v1/catalogo_productos')) return json([{ id: 5, name: 'Collar hawaiano', sku: 'COL', active: true }, { id: 6, name: 'Bombín', sku: 'BOM', active: true }]);
    return json([]);
  };
  return llamadas;
}
async function llamarTool(name, args) {
  const res = await llamar({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return res.body.result;
}

test('inventario: las herramientas se ven según el permiso de la llave', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  try {
    mockInventario(['inventory:read']);
    let res = await llamar({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(res.body.result.tools.map(t => t.name).sort(), ['consultar_inventario', 'listar_movimientos_inventario']);
    mockInventario(['inventory:read', 'inventory:write']);
    res = await llamar({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(res.body.result.tools.some(t => t.name === 'crear_movimiento_inventario'));
    assert.ok(!res.body.result.tools.some(t => t.name === 'aprobar_movimiento_inventario'), 'aprobar necesita su propio permiso');
    const r = await llamarTool('aprobar_movimiento_inventario', { folio: 'SAL-1-0001', confirmar: true });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /inventory:approve/);
  } finally { global.fetch = prev; }
});

test('inventario: consultar existencias por sucursal', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  mockInventario(['inventory:read'], { stock: { 5: { rumania: 10, puebla: 3, queretaro: 0 } } });
  try {
    const r = await llamarTool('consultar_inventario', { ids: [5] });
    const p = r.structuredContent.productos[0];
    assert.deepEqual(p.existencias, { 'CDMX Rumania': 10, Puebla: 3, Querétaro: 0 });
    assert.equal(p.total, 13);
  } finally { global.fetch = prev; }
});

test('inventario: crear un borrador de salida/traspaso avisa si pide más de lo que hay y quién lo creó', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const llamadas = mockInventario(['inventory:write'], { stock: { 5: { puebla: 2 } } });
  try {
    const r = await llamarTool('crear_movimiento_inventario', { tipo: 'traspaso', desde: 'Puebla', hacia: 'CDMX', motivo: 'Surtir Rumania', partidas: [{ id_product: 5, cantidad: 4 }] });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal(r.structuredContent.estado, 'borrador');
    assert.match(r.structuredContent.advertencias_existencias[0], /pides 4 y en Puebla hay 2/);
    const save = llamadas.find(l => l.u.includes('/rpc/mov_doc_save_core'));
    const b = JSON.parse(save.opts.body);
    assert.equal(b.p_origen, 'puebla'); assert.equal(b.p_destino, 'rumania'); assert.equal(b.p_por, 'Asistente (MCP: ChatGPT)');
    assert.deepEqual(b.p_items.map(i => [i.id_product, i.qty, i.name]), [[5, 4, 'Collar hawaiano']]);
    assert.ok(!llamadas.some(l => l.u.includes('/rpc/mov_doc_approve_core')), 'crear nunca aprueba');
  } finally { global.fetch = prev; }
});

test('inventario: validaciones (sucursal, cantidades, ajuste de entrada sin tipo, producto inexistente)', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  mockInventario(['inventory:write']);
  try {
    const mal = async (a, re) => { const r = await llamarTool('crear_movimiento_inventario', a); assert.equal(r.isError, true, JSON.stringify(a)); assert.match(r.content[0].text, re); };
    await mal({ tipo: 'salida', desde: 'Mérida', motivo: 'x', partidas: [{ id_product: 5, cantidad: 1 }] }, /sucursal no válida/);
    await mal({ tipo: 'salida', desde: 'puebla', motivo: 'merma', partidas: [{ id_product: 5, cantidad: 0 }] }, /cantidad entera/);
    await mal({ tipo: 'salida', desde: 'puebla', motivo: 'merma', partidas: [{ id_product: 5, cantidad: 1.5 }] }, /cantidad entera/);
    await mal({ tipo: 'ajuste_entrada', hacia: 'puebla', motivo: 'Se encontraron 3', partidas: [{ id_product: 5, cantidad: 3 }] }, /tipo_ajuste/);
    await mal({ tipo: 'ajuste_entrada', hacia: 'puebla', tipo_ajuste: 'conteo', motivo: 'ok', partidas: [{ id_product: 5, cantidad: 3 }] }, /al menos 5/);
    await mal({ tipo: 'salida', desde: 'puebla', motivo: 'merma', partidas: [{ id_product: 999, cantidad: 1 }] }, /No existen estos productos: 999/);
    await mal({ tipo: 'compra', desde: 'puebla', motivo: 'x', partidas: [{ id_product: 5, cantidad: 1 }] }, /salida, traspaso o ajuste_entrada/);
  } finally { global.fetch = prev; }
});

test('inventario: aprobar exige confirmar, respeta el stock y aplica el borrador', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const doc = { id: 9, folio: 'SAL-261022-0001', tipo: 'salida', estado: 'borrador', origen: 'puebla', destino: null, motivo: 'merma', creado_por: 'Asistente (MCP: ChatGPT)', items: [{ id_product: 5, qty: 3, name: 'Collar hawaiano' }] };
  try {
    let llamadas = mockInventario(['inventory:approve'], { stock: { 5: { puebla: 10 } }, documento: doc });
    let r = await llamarTool('aprobar_movimiento_inventario', { folio: doc.folio });
    assert.match(r.content[0].text, /confirmar=true/);
    assert.ok(!llamadas.some(l => l.u.includes('/rpc/mov_doc_approve_core')));
    r = await llamarTool('aprobar_movimiento_inventario', { folio: doc.folio, confirmar: true });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal(r.structuredContent.aprobado, true);
    assert.equal(JSON.parse(llamadas.find(l => l.u.includes('/rpc/mov_doc_approve_core')).opts.body).p_por, 'Asistente (MCP: ChatGPT)');
    // sin existencia suficiente no aprueba
    llamadas = mockInventario(['inventory:approve'], { stock: { 5: { puebla: 1 } }, documento: doc });
    r = await llamarTool('aprobar_movimiento_inventario', { folio: doc.folio, confirmar: true });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /No hay existencia suficiente en Puebla/);
    assert.ok(!llamadas.some(l => l.u.includes('/rpc/mov_doc_approve_core')));
    // ya aprobado
    mockInventario(['inventory:approve'], { documento: { ...doc, estado: 'aprobado' } });
    r = await llamarTool('aprobar_movimiento_inventario', { folio: doc.folio, confirmar: true });
    assert.match(r.content[0].text, /ya está aprobado/);
  } finally { global.fetch = prev; }
});
