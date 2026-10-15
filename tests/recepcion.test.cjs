const test = require('node:test'), assert = require('node:assert/strict');

// La IA se sustituye por un doble: estas pruebas cubren lo que hace el servidor alrededor de ella.
const iaPath = require.resolve('../lib/recepcion-ia.js');
const iaReal = require(iaPath);
let lecturaFalsa = null;
require.cache[iaPath].exports = {
  ...iaReal,
  leerNota: async () => { if (lecturaFalsa instanceof Error) throw lecturaFalsa; return lecturaFalsa; }
};
const handler = require('../api/recepcion.js');
const { normalizarLectura } = iaReal;

function response() {
  return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
}

function mockFetch({ sesionOk = true } = {}) {
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    llamadas.push({ u, body, opts });
    const ok = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d });
    if (u.endsWith('/rpc/recep_sesion')) {
      return sesionOk ? ok({ nombre: 'Ana', supervisor: false, admin: false })
        : { ok: false, status: 400, text: async () => JSON.stringify({ message: 'unauthorized' }) };
    }
    if (u.endsWith('/rpc/recep_srv_procesando')) return ok({ folio: 'REC-261009-0001', proveedor: 'Prov A', almacen: 'puebla' });
    if (u.includes('/storage/v1/object/recepciones/')) return ok({ Key: 'x' });
    if (u.endsWith('/rpc/recep_srv_guardar_lectura')) return ok({ recepcion: { id: 7 }, lineas: body.p_lectura.lineas });
    if (u.endsWith('/rpc/recep_srv_fallo')) return ok(null);
    throw new Error('fetch inesperado: ' + u);
  };
  return llamadas;
}

const creds = { p_admin_password: null, p_staff_email: 'ana@x.mx', p_staff_pin: '1111' };
const foto = { nombre: 'nota.jpg', media_type: 'image/jpeg', data: Buffer.from('foto-de-la-nota').toString('base64') };

test('normalizarLectura conserva el código tal cual y marca lo dudoso', () => {
  const d = normalizarLectura({
    folio: ' F-12 ', fecha: '2026-10-09', proveedor: 'X', subtotal: null, total: 999,
    lineas: [
      { codigo: ' 0088-A ', descripcion: null, cantidad: 10, precio_unitario: 2.5, importe: 25, legible: true, nota: null },
      { codigo: 'A59B', descripcion: null, cantidad: 3, precio_unitario: 10, importe: 50, legible: true, nota: null },
      { codigo: null, descripcion: null, cantidad: null, precio_unitario: 4, importe: null, legible: false, nota: 'mancha' }
    ],
    advertencias: []
  });
  assert.equal(d.folio, 'F-12');
  assert.equal(d.lineas[0].codigo, '0088-A');            // ceros, guion y letras intactos
  assert.equal(d.lineas[0].revisar, false);
  assert.match(d.lineas[1].revisar_motivo, /no coincide con el importe/);
  assert.equal(d.lineas[2].revisar, true);
  assert.match(d.lineas[2].revisar_motivo, /mancha/);
  assert.ok(d.advertencias.length === 0 || d.advertencias.every(a => typeof a === 'string'));
});

test('normalizarLectura avisa si la suma no coincide con el total', () => {
  const d = normalizarLectura({ folio: null, fecha: 'ayer', proveedor: null, subtotal: null, total: 100,
    lineas: [{ codigo: 'X1', descripcion: null, cantidad: 1, precio_unitario: 10, importe: 10, legible: true, nota: null }], advertencias: [] });
  assert.equal(d.fecha, null);
  assert.match(d.advertencias.join(' '), /no coincide con el total/);
});

test('sin sesión válida no hace nada', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const llamadas = mockFetch({ sesionOk: false });
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'leer_nota', creds, recepcion_id: 1, archivos: [foto] } }, res);
    assert.equal(res.code, 401);
    assert.equal(llamadas.length, 1);
  } finally { global.fetch = prev; }
});

test('sin nota escaneada: INGRESO NO PERMITIDO', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const llamadas = mockFetch();
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'leer_nota', creds, recepcion_id: 1, archivos: [] } }, res);
    assert.equal(res.code, 400);
    assert.match(res.data.error, /INGRESO NO PERMITIDO/);
    assert.ok(!llamadas.some(l => l.u.includes('recep_srv')), 'no debe tocar la recepción');
  } finally { global.fetch = prev; }
});

test('lee la nota: sube el archivo, guarda la lectura limpia con huella', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const llamadas = mockFetch();
  lecturaFalsa = { modelo: 'claude-opus-5-5', folio: 'F-1', fecha: '2026-10-09', proveedor: null, subtotal: null, total: 50,
    lineas: [{ codigo: '007', descripcion: null, cantidad: 5, precio_unitario: 10, importe: 50, legible: true, nota: null }], advertencias: [] };
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'leer_nota', creds, recepcion_id: 7, archivos: [foto] } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const subida = llamadas.find(l => l.u.includes('/storage/v1/object/recepciones/REC-261009-0001/'));
    assert.ok(subida, 'sube la nota al bucket privado');
    const g = llamadas.find(l => l.u.endsWith('/rpc/recep_srv_guardar_lectura')).body;
    assert.equal(g.p_id, 7);
    assert.equal(g.p_lectura.lineas[0].codigo, '007');
    assert.equal(g.p_archivos.length, 1);
    assert.match(g.p_hash, /^[0-9a-f]{64}$/);
    assert.equal(g.p_por, 'Ana');
  } finally { global.fetch = prev; lecturaFalsa = null; }
});

test('si la IA falla, la recepción regresa a borrador', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const llamadas = mockFetch();
  lecturaFalsa = new Error('timeout');
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'leer_nota', creds, recepcion_id: 7, archivos: [foto] } }, res);
    assert.equal(res.code, 502);
    assert.ok(llamadas.some(l => l.u.endsWith('/rpc/recep_srv_fallo')));
    assert.ok(!llamadas.some(l => l.u.endsWith('/rpc/recep_srv_guardar_lectura')));
  } finally { global.fetch = prev; lecturaFalsa = null; }
});

test('rechaza archivos que no son foto ni PDF', async () => {
  const prev = global.fetch; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  mockFetch();
  try {
    const res = response();
    await handler({ method: 'POST', body: { accion: 'leer_nota', creds, recepcion_id: 7, archivos: [{ media_type: 'text/html', data: 'eA==' }] } }, res);
    assert.equal(res.code, 400);
  } finally { global.fetch = prev; }
});

test('con OPENAI_API_KEY la nota se lee con ChatGPT (salida JSON estricta)', async () => {
  const prev = global.fetch; const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-prueba';
  let enviado = null;
  global.fetch = async (url, opts) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer sk-prueba');
    enviado = JSON.parse(opts.body);
    const datos = { folio: 'F-9', fecha: '2026-10-09', proveedor: null, subtotal: null, total: 20,
      lineas: [{ codigo: '0012', descripcion: null, cantidad: 2, precio_unitario: 10, importe: 20, legible: true, nota: null }], advertencias: [] };
    return { ok: true, status: 200, json: async () => ({ model: 'gpt-5', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(datos) } }] }) };
  };
  try {
    const r = await iaReal.leerNota([{ media_type: 'image/jpeg', data: 'QUJD' }, { media_type: 'application/pdf', data: 'UERG' }], { proveedor: 'Prov A' });
    assert.equal(r.lineas[0].codigo, '0012');
    assert.equal(r.modelo, 'gpt-5');
    assert.equal(enviado.response_format.type, 'json_schema');
    assert.equal(enviado.response_format.json_schema.strict, true);
    const partes = enviado.messages[1].content;
    assert.ok(partes.some(p => p.type === 'image_url' && p.image_url.url === 'data:image/jpeg;base64,QUJD'));
    assert.ok(partes.some(p => p.type === 'file' && p.file.file_data === 'data:application/pdf;base64,UERG'));
  } finally {
    global.fetch = prev;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
  }
});

test('sin ninguna llave de IA avisa qué falta', async () => {
  const a = process.env.OPENAI_API_KEY, b = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try { await assert.rejects(iaReal.leerNota([{ media_type: 'image/jpeg', data: 'QUJD' }]), /OPENAI_API_KEY/); }
  finally { if (a) process.env.OPENAI_API_KEY = a; if (b) process.env.ANTHROPIC_API_KEY = b; }
});
