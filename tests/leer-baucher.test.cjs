const test = require('node:test'), assert = require('node:assert/strict');
const sesion = require('../lib/sesion-panel.js');
const ia = require('../lib/recepcion-ia.js');
sesion.sesionPanel = async () => ({ nombre: 'Caja' });
let respuesta = { legible: true, monto: 1234.5, tipo: 'transferencia', fecha: null, referencia: null };
ia.generarJson = async () => respuesta;
const handler = require('../api/leer-baucher.js');
const call = body => { const res = { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } }; return handler({ method: 'POST', body, headers: {} }, res).then(() => res); };
const img = { media_type: 'image/jpeg', data: 'AAAA' };

test('leer-baucher: devuelve el monto leído', async () => {
  const r = await call({ image: img });
  assert.equal(r.code, 200); assert.equal(r.data.monto, 1234.5);
});
test('leer-baucher: foto ilegible o sin monto -> monto null', async () => {
  respuesta = { legible: false, monto: null, tipo: 'otro', fecha: null, referencia: null };
  let r = await call({ image: img }); assert.equal(r.data.monto, null);
  respuesta = { legible: true, monto: 0, tipo: 'otro', fecha: null, referencia: null };
  r = await call({ image: img }); assert.equal(r.data.monto, null);
});
test('leer-baucher: rechaza tipos de archivo no válidos', async () => {
  const r = await call({ image: { media_type: 'application/pdf', data: 'AAAA' } });
  assert.equal(r.code, 400);
});
