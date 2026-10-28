// Cola de optimización SEO con IA (lib/seo-cola.js): entran los productos que lo necesitan (más
// vendidos primero), la IA propone de 3 en 3, se aprueba con las correcciones del usuario y se
// puede deshacer.
const test = require('node:test'), assert = require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';

const PALABRAS = n => '<p>' + 'texto '.repeat(n) + '</p>';
function db() {
  return {
    catalogo: [
      { id: 1, name: 'Globo rojo', active: true, meta_title: '', meta_description: '', description: '<p>Globo</p>', images: ['a', 'b'] },
      { id: 2, name: 'Vela mágica', active: true, meta_title: '', meta_description: '', description: '<p>Vela</p>', images: ['a', 'b'] },
      { id: 3, name: 'Corona', active: true, meta_title: 'Corona dorada para fiesta', meta_description: 'x'.repeat(130), description: PALABRAS(150), images: ['a', 'b'] },
      { id: 4, name: 'Collar', active: true, meta_title: '', meta_description: '', description: '', images: ['a', 'b'] }
    ],
    migrados: [{ id: 2, description: '<p>Vela vieja</p>' }],
    cola: [],
    ventas: [{ product_id: 2, units: 50 }, { product_id: 4, units: 5 }]
  };
}
function fake(d) {
  const llamadas = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url)); const m = opts.method || 'GET'; llamadas.push(`${m} ${u}`);
    const ok = x => ({ ok: true, status: 200, text: async () => (x === null ? '' : JSON.stringify(x)) });
    const ids = (u.match(/(?:id|product_id)=in\.\(([^)]*)\)/) || [])[1];
    const lista = ids ? ids.split(',').map(Number) : null;
    const eqId = Number((u.match(/[?&](?:id|product_id)=eq\.(\d+)/) || [])[1]);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.includes('/catalogo_productos')) {
      if (m === 'PATCH') { const p = d.catalogo.find(x => x.id === eqId); Object.assign(p, body); return ok([p]); }
      return ok(d.catalogo.filter(p => !lista || lista.includes(p.id)));
    }
    if (u.includes('/productos_migrados')) {
      if (m === 'PATCH') { const p = d.migrados.find(x => x.id === eqId); if (p) Object.assign(p, body); return ok(null); }
      return ok(d.migrados.filter(p => !lista || lista.includes(p.id)));
    }
    if (u.includes('ventas_producto_mes')) return ok(u.includes('/ps_') ? d.ventas : []);
    if (u.includes('/seo_cola_productos')) {
      if (m === 'POST') { body.forEach(r => { if (!d.cola.some(c => c.product_id === r.product_id)) d.cola.push({ intentos: 0, ...r }); }); return ok(null); }
      let filas = d.cola;
      if (lista) filas = filas.filter(c => lista.includes(c.product_id));
      if (eqId) filas = filas.filter(c => c.product_id === eqId);
      const est = u.match(/estado=eq\.(\w+)/); if (est) filas = filas.filter(c => c.estado === est[1]);
      const estIn = u.match(/estado=in\.\(([^)]*)\)/); if (estIn) filas = filas.filter(c => estIn[1].split(',').includes(c.estado));
      if (u.includes('error=is.null')) filas = filas.filter(c => !c.error);
      if (u.includes('or=(estado.eq.pendiente')) filas = filas.filter(c => c.estado === 'pendiente' || (c.estado === 'error' && c.intentos < 3));
      if (m === 'PATCH') { filas.forEach(c => Object.assign(c, body)); return ok(null); }
      filas = [...filas].sort((a, b) => b.prioridad - a.prioridad || a.product_id - b.product_id);
      const lim = Number((u.match(/limit=(\d+)/) || [])[1]) || filas.length;
      return ok(filas.slice(0, lim));
    }
    return ok([]);
  };
  return llamadas;
}

test('llenar: solo los que lo necesitan, con las ventas como prioridad; sin duplicar', async () => {
  const d = db(); fake(d);
  const cola = require('../lib/seo-cola.js');
  const r = await cola.llenar();
  assert.equal(r.agregados, 3);
  assert.deepEqual(d.cola.map(c => [c.product_id, c.prioridad]).sort(), [[1, 0], [2, 50], [4, 5]]);
  assert.equal((await cola.llenar()).agregados, 0);
});

test('procesar: la IA propone de 3 en 3 empezando por los más vendidos; aprobar guarda lo editado y deshacer lo regresa', async () => {
  const d = db(); fake(d);
  const ia = require('../lib/recepcion-ia.js');
  const prev = ia.generarJson;
  const pedidos = [];
  ia.generarJson = async o => {
    const lineas = o.contenido[0].text.split('\n').slice(1).map(l => JSON.parse(l));
    pedidos.push(lineas.map(l => l.id));
    return { productos: lineas.map(l => ({ id: l.id, palabra_clave: 'k', meta_title: `Título ${l.id}`, meta_description: 'm'.repeat(130), descripcion_html: `<p>Descripción ${l.id}</p><script>x</script>` })) };
  };
  try {
    const cola = require('../lib/seo-cola.js');
    await cola.llenar();
    const r = await cola.procesar({ tiempoMaxMs: 120000 });
    assert.equal(r.propuestos, 3);
    assert.deepEqual([...pedidos[0]].sort(), [1, 2, 4]);
    assert.ok(d.cola.every(c => c.estado === 'propuesto'));
    assert.deepEqual((await cola.lista({ estado: 'propuesto' })).items.map(i => i.id), [2, 4, 1]); // más vendidos primero

    const s = { nombre: 'Ana' };
    const a = await cola.aprobar({ ids: [2], ediciones: { 2: { meta_title: 'Vela mágica para pastel | Mi Fiestashop' } } }, s);
    assert.equal(a.aprobados, 1);
    const vela = d.catalogo.find(p => p.id === 2);
    assert.equal(vela.meta_title, 'Vela mágica para pastel');
    assert.equal(vela.description, '<p>Descripción 2</p>');
    assert.equal(d.migrados[0].description, '<p>Descripción 2</p>');
    const fila = d.cola.find(c => c.product_id === 2);
    assert.equal(fila.estado, 'aprobado'); assert.equal(fila.revisado_por, 'Ana');

    await cola.deshacer({ id: 2 }, s);
    assert.equal(vela.description, '<p>Vela</p>');
    assert.equal(vela.meta_title, null);
    assert.equal(d.migrados[0].description, '<p>Vela vieja</p>');
    assert.equal(fila.estado, 'propuesto');

    await cola.rechazar({ ids: [4] }, s);
    assert.equal(d.cola.find(c => c.product_id === 4).estado, 'rechazado');
    await cola.reintentar({ ids: [4] });
    assert.equal(d.cola.find(c => c.product_id === 4).estado, 'pendiente');
    const res = await cola.resumen();
    assert.deepEqual([res.propuesto, res.pendiente], [2, 1]);
  } finally { ia.generarJson = prev; }
});

test('procesar: si la IA falla, se marca con error y se reintenta hasta 3 veces', async () => {
  const d = db(); fake(d);
  const ia = require('../lib/recepcion-ia.js');
  const prev = ia.generarJson;
  ia.generarJson = async () => { throw new Error('OpenAI 500: caído'); };
  try {
    const cola = require('../lib/seo-cola.js');
    await cola.llenar();
    await cola.procesar({ tiempoMaxMs: 65000 });
    assert.ok(d.cola.every(c => c.estado === 'error' && c.intentos >= 1 && c.intentos <= 3));
  } finally { ia.generarJson = prev; }
});

test('aprobación automática: aprueba lo que pasa los controles y deja el resto por revisar con la razón', async () => {
  const d = db(); fake(d);
  const buena = { palabra_clave: 'k', meta_title: 'Globo rojo para fiesta de cumpleaños', meta_description: 'm'.repeat(140), descripcion_html: PALABRAS(130) };
  d.cola = [
    { product_id: 1, prioridad: 5, estado: 'propuesto', propuesta: buena, intentos: 0 },
    { product_id: 2, prioridad: 9, estado: 'propuesto', propuesta: { ...buena, descripcion_html: PALABRAS(130) + '<p>Solo $25 la pieza</p>' }, intentos: 0 },
    { product_id: 4, prioridad: 1, estado: 'propuesto', propuesta: { ...buena, meta_title: 'X' }, intentos: 0 }
  ];
  const cola = require('../lib/seo-cola.js');
  const r = await cola.aprobarAutomaticas();
  assert.deepEqual(r, { aprobados: 1, a_revisar: 2 });
  assert.equal(d.cola[0].estado, 'aprobado');
  assert.equal(d.cola[0].revisado_por, 'IA (aprobación automática)');
  assert.equal(d.catalogo.find(p => p.id === 1).meta_title, 'Globo rojo para fiesta de cumpleaños');
  assert.equal(d.cola[1].estado, 'propuesto'); assert.match(d.cola[1].error, /precios/);
  assert.match(d.cola[2].error, /título de 1 caracteres/);
  assert.deepEqual(await cola.aprobarAutomaticas(), { aprobados: 0, a_revisar: 0 }); // no repite las ya marcadas
});

test('la revisión automática rechaza títulos con palabras repetidas', () => {
  const { revisarPropuesta } = require('../lib/seo-cola.js');
  const base = { meta_description: 'x'.repeat(120), descripcion_html: PALABRAS(120) };
  assert.ok(revisarPropuesta({ ...base, meta_title: 'Globo gato - globo gato mayoreo' }).includes('título con palabras repetidas'));
  assert.ok(revisarPropuesta({ ...base, meta_title: 'Peluca Afro Payaso: peluca afro payaso multicolor' }).includes('título con palabras repetidas'));
  assert.ok(!revisarPropuesta({ ...base, meta_title: 'Globo gato metálico para cumpleaños' }).includes('título con palabras repetidas'));
});
