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
