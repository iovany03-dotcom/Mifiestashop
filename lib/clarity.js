// API de exportación de datos de Microsoft Clarity (project-live-insights).
// Docs: https://learn.microsoft.com/clarity/setup-and-installation/clarity-data-export-api
// Token: CLARITY_API_TOKEN (Vercel; Clarity → Configuración → Exportación de datos).
// Límite de Clarity: 10 consultas por proyecto al día, de los últimos 1 a 3 días, hasta 3
// dimensiones por consulta. Por eso se guarda un resumen al día (api/cron-clarity.js).
const URL_API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';

// Consultas del día (6 de las 10 permitidas; quedan 4 de margen).
const CONSULTAS = [[], ['Device'], ['URL'], ['Device', 'URL'], ['Channel'], ['Browser']];

async function consultar(dimensiones, dias = 1) {
  const token = process.env.CLARITY_API_TOKEN;
  if (!token) throw new Error('Falta CLARITY_API_TOKEN en Vercel.');
  const q = new URLSearchParams({ numOfDays: String(dias) });
  dimensiones.forEach((d, i) => q.set(`dimension${i + 1}`, d));
  const r = await fetch(`${URL_API}?${q}`, { headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000) });
  const texto = await r.text();
  if (!r.ok) {
    const e = new Error(`Clarity respondió HTTP ${r.status}: ${texto.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(texto);
}

const num = v => { const n = Number(String(v ?? '').replace(/[,%\s]/g, '')); return Number.isFinite(n) ? n : null; };

// [{ metricName, information: [{ <Dimensión>: valor, <métricas>... }] }] ->
// Map clave -> { dims: {Device: 'Mobile', ...}, m: { Traffic: {totalSessionCount: 123, ...}, ... } }
function normalizar(respuesta, dimensiones) {
  const filas = new Map();
  for (const bloque of Array.isArray(respuesta) ? respuesta : []) {
    const metrica = bloque && bloque.metricName;
    if (!metrica) continue;
    for (const info of Array.isArray(bloque.information) ? bloque.information : []) {
      const dims = {};
      dimensiones.forEach(d => { dims[d] = info[d] ?? info[d.toLowerCase()] ?? '(sin dato)'; });
      const clave = dimensiones.map(d => dims[d]).join(' | ') || 'total';
      if (!filas.has(clave)) filas.set(clave, { dims, m: {} });
      const valores = {};
      for (const [k, v] of Object.entries(info)) {
        if (dimensiones.includes(k) || dimensiones.map(d => d.toLowerCase()).includes(k)) continue;
        const n = num(v);
        valores[k] = n === null ? v : n;
      }
      filas.get(clave).m[metrica] = valores;
    }
  }
  return [...filas.values()];
}

// Toma la primera llave que exista (la API ha usado nombres distintos para lo mismo, p. ej.
// "distinantUserCount").
function valor(m, metrica, ...llaves) {
  const o = m && m[metrica];
  if (!o) return null;
  for (const k of llaves) {
    const hit = Object.keys(o).find(x => x.toLowerCase() === k.toLowerCase());
    if (hit && typeof o[hit] === 'number') return o[hit];
  }
  return null;
}

// Fila normalizada -> números para el tablero.
function resumenFila(f) {
  const m = f.m;
  const pct = metrica => valor(m, metrica, 'sessionsWithMetricPercentage', 'percentage');
  return {
    dims: f.dims,
    sesiones: valor(m, 'Traffic', 'totalSessionCount', 'sessionsCount'),
    bots: valor(m, 'Traffic', 'totalBotSessionCount'),
    usuarios: valor(m, 'Traffic', 'distinctUserCount', 'distinantUserCount'),
    paginas_por_sesion: valor(m, 'Traffic', 'pagesPerSessionPercentage', 'pagesPerSession'),
    scroll: valor(m, 'ScrollDepth', 'averageScrollDepth', 'scrollDepth'),
    tiempo_total: valor(m, 'EngagementTime', 'totalTime'),
    tiempo_activo: valor(m, 'EngagementTime', 'activeTime'),
    clics_inactivos: pct('DeadClickCount'),
    clics_ira: pct('RageClickCount'),
    regresos_rapidos: pct('QuickbackClick'),
    scroll_excesivo: pct('ExcessiveScroll'),
    errores_js: pct('ScriptErrorCount'),
    clics_error: pct('ErrorClickCount')
  };
}

module.exports = { CONSULTAS, consultar, normalizar, resumenFila, valor };
