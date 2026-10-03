// Estimado de ventas mensuales de un producto, para el editor del admin.
//  1) Real: promedio de unidades por mes de los últimos meses CERRADOS (el mes en curso queda aparte
//     porque está incompleto) con las ventas que registra el sistema (PrestaShop + POS propio). El primer
//     mes con datos del sistema también se descarta: empieza a mitad de mes y subestimaría.
//  2) Por similitud: si el producto casi no tiene ventas propias (o es nuevo), se busca entre los
//     productos que sí se venden los que más se le parecen (palabras del nombre, categoría y rango de
//     precio) y se estima con lo que venden ellos.
const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'para', 'con', 'sin', 'y', 'en', 'al', 'un', 'una', 'por', 'pza', 'pzas', 'pieza', 'piezas', 'paquete', 'pack', 'set', 'kit', 'color', 'colores']);

function normaliza(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokens(name) {
  const out = new Set();
  normaliza(name).split(/[^a-z0-9]+/).forEach(t => {
    if (t.length < 3 || /^\d+$/.test(t) || STOP.has(t)) return;
    out.add(t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t);
  });
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach(t => { if (b.has(t)) inter++; });
  return inter / (a.size + b.size - inter);
}

// "YYYY-MM" de los últimos n meses cerrados antes de `hoy` (más antiguo primero).
function mesesCerrados(hoy, n) {
  const out = [];
  let y = hoy.getUTCFullYear(), m = hoy.getUTCMonth(); // m = mes en curso (0-11)
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    out.unshift(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  return out;
}

// rows: [{ product_id, month: 'YYYY-MM', units }] -> { porProducto: Map(id -> { 'YYYY-MM': unidades }), primerMes }
function agregarVentas(rows) {
  const porProducto = new Map();
  let primerMes = null;
  rows.forEach(r => {
    if (!r.month || !/^\d{4}-\d{2}$/.test(r.month)) return;
    const id = String(r.product_id);
    const units = Number(r.units) || 0;
    if (!porProducto.has(id)) porProducto.set(id, {});
    const m = porProducto.get(id);
    m[r.month] = (m[r.month] || 0) + units;
    if (!primerMes || r.month < primerMes) primerMes = r.month;
  });
  return { porProducto, primerMes };
}

// Promedio mensual real de un producto: { promedio, meses, mesesConVenta, unidades, mesActual }.
function estimarReal(meses, primerMes, hoy) {
  let ventana = mesesCerrados(hoy, 6);
  if (primerMes) {
    const sinParcial = ventana.filter(m => m > primerMes);
    ventana = sinParcial.length ? sinParcial : ventana.filter(m => m >= primerMes);
  }
  const mesActual = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}`;
  const datos = meses || {};
  const unidades = ventana.reduce((s, m) => s + (datos[m] || 0), 0);
  return {
    promedio: ventana.length ? unidades / ventana.length : 0,
    meses: ventana.length,
    mesesConVenta: ventana.filter(m => (datos[m] || 0) > 0).length,
    unidades,
    mesActual: { mes: mesActual, unidades: datos[mesActual] || 0 }
  };
}

function mediana(vals) {
  const a = vals.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// objetivo: { id?, name, categoryLabel?, price? }; candidatos: [{ id, name, categoryLabel, price, promedio }]
function estimarPorSimilares(objetivo, candidatos, max = 5) {
  const tObj = tokens(objetivo.name);
  const cat = normaliza(objetivo.categoryLabel);
  const precio = Number(objetivo.price) || 0;
  const scored = [];
  candidatos.forEach(c => {
    if (!(c.promedio > 0) || (objetivo.id != null && String(c.id) === String(objetivo.id))) return;
    const j = jaccard(tObj, tokens(c.name));
    if (j <= 0) return;
    const mismaCat = cat && normaliza(c.categoryLabel) === cat ? 1 : 0;
    const pc = Number(c.price) || 0;
    const precioSim = precio > 0 && pc > 0 ? Math.min(precio, pc) / Math.max(precio, pc) : 0;
    const score = 0.7 * j + 0.15 * mismaCat + 0.15 * precioSim;
    if (score >= 0.3) scored.push({ id: c.id, name: c.name, promedio: c.promedio, score });
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max);
  if (!top.length) return null;
  const vals = top.map(t => t.promedio);
  const fuertes = top.filter(t => t.score >= 0.5).length;
  return {
    promedio: mediana(vals),
    bajo: Math.min(...vals), alto: Math.max(...vals),
    confianza: fuertes >= 3 ? 'alta' : (top.length >= 3 || fuertes >= 1 ? 'media' : 'baja'),
    similares: top.map(t => ({ id: t.id, name: t.name, promedio: Math.round(t.promedio * 10) / 10, parecido: Math.round(t.score * 100) }))
  };
}

module.exports = { tokens, jaccard, mesesCerrados, agregarVentas, estimarReal, estimarPorSimilares, mediana };
