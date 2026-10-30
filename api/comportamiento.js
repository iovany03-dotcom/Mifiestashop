// Vercel serverless function: Estadísticas → Comportamiento en la tienda (index.html).
// Junta el resumen diario de Microsoft Clarity (clarity_diario, ver api/cron-clarity.js) de los
// últimos N días con los datos propios por página (comportamiento_paginas: visitas, carrito,
// compra, velocidad real). Requiere sesión del panel.
//
// POST { dias: 1|7|30 } (header x-mfs-sesion) -> { dias, fechas, ultima, totales, serie,
//   dispositivos, paginas, canales, navegadores, listas }
const { sb, sbTodo } = require('../lib/seo-datos.js');
const { exigirSesion } = require('../lib/sesion-panel.js');
const clarity = require('../lib/clarity.js');

const CAMPOS_PROMEDIO = ['paginas_por_sesion', 'scroll', 'tiempo_activo', 'tiempo_total', 'clics_inactivos', 'clics_ira', 'regresos_rapidos', 'scroll_excesivo', 'errores_js', 'clics_error'];

// Suma sesiones/usuarios y promedia lo demás ponderado por sesiones (varios días de una misma fila).
function juntar(lista) {
  const out = { sesiones: 0, usuarios: 0, bots: 0 };
  const pesos = {};
  for (const r of lista) {
    const w = r.sesiones || 0;
    out.sesiones += w; out.usuarios += r.usuarios || 0; out.bots += r.bots || 0;
    for (const k of CAMPOS_PROMEDIO) {
      if (r[k] == null || !w) continue;
      out[k] = (out[k] || 0) + r[k] * w;
      pesos[k] = (pesos[k] || 0) + w;
    }
  }
  for (const k of CAMPOS_PROMEDIO) out[k] = pesos[k] ? Math.round(out[k] / pesos[k] * 10) / 10 : null;
  return out;
}

function porDimension(filasDb, dimension) {
  const dims = dimension ? dimension.split(',') : [];
  const grupos = new Map();
  for (const f of filasDb.filter(x => x.dimension === dimension)) {
    for (const fila of clarity.normalizar(f.datos, dims).filas) {
      const r = clarity.resumenFila(fila);
      const clave = JSON.stringify(r.dims);
      if (!grupos.has(clave)) grupos.set(clave, { dims: r.dims, filas: [] });
      grupos.get(clave).filas.push(r);
    }
  }
  return [...grupos.values()].map(g => ({ ...g.dims, ...juntar(g.filas) })).sort((a, b) => b.sesiones - a.sesiones);
}

// Página sin los parámetros de anuncios (utm, fbclid...): el carrito y las búsquedas, que son la
// misma ruta "/" con ?vista= o ?buscar=, se cuentan aparte.
function rutaDe(u) {
  try {
    const x = new URL(u, 'https://www.mifiestashop.com');
    if (x.searchParams.get('buscar')) return '/?buscar=…';
    if (x.searchParams.get('vista')) return `/?vista=${x.searchParams.get('vista')}`;
    return x.pathname;
  } catch (e) { return String(u || ''); }
}

const handler = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await exigirSesion(req, res, ['dashboard', 'embudo', 'comportamiento']))) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const dias = [1, 7, 30, 90].includes(Number(body.dias)) ? Number(body.dias) : 7;
  try {
    const desde = new Date(Date.now() - dias * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
    const [filasDb, estado] = await Promise.all([
      sbTodo(`/rest/v1/clarity_diario?fecha=gte.${desde}&select=fecha,dimension,datos,obtenido_at&order=fecha.asc`),
      sb('/rest/v1/ps_sync_estado?dominio=eq.clarity&select=last_synced_at,ultimo_resultado')
    ]);
    const fechas = [...new Set(filasDb.map(f => f.fecha))];
    const out = { dias, fechas, ultima: estado[0] || null, token: !!process.env.CLARITY_API_TOKEN };
    if (!fechas.length) { res.status(200).json({ ...out, totales: null }); return; }

    // Total y serie por día (consulta sin dimensiones).
    const serie = filasDb.filter(f => f.dimension === '').map(f => {
      const fila = clarity.normalizar(f.datos, []).filas[0];
      return { fecha: f.fecha, ...(fila ? clarity.resumenFila(fila) : {}) };
    });
    out.serie = serie.map(({ dims, ...r }) => r);
    out.totales = juntar(serie);

    // Listas del resumen general (navegador, sistema, país, de dónde llegan, páginas populares).
    const listas = {};
    for (const f of filasDb.filter(x => x.dimension === '')) {
      for (const [metrica, items] of Object.entries(clarity.normalizar(f.datos, []).listas)) {
        listas[metrica] = listas[metrica] || new Map();
        for (const it of items) listas[metrica].set(it.nombre, (listas[metrica].get(it.nombre) || 0) + it.sesiones);
      }
    }
    out.listas = Object.fromEntries(Object.entries(listas).map(([k, m]) => [k, [...m.entries()].map(([nombre, sesiones]) => ({ nombre, sesiones })).sort((a, b) => b.sesiones - a.sesiones).slice(0, 15)]));

    out.dispositivos = porDimension(filasDb, 'Device');
    out.canales = porDimension(filasDb, 'Channel');
    out.navegadores = porDimension(filasDb, 'Browser').slice(0, 10);

    // Páginas: Clarity por URL + celular (Device,URL) + datos propios por ruta.
    const paginas = porDimension(filasDb, 'URL');
    const movil = new Map();
    for (const x of porDimension(filasDb, 'Device,URL').filter(x => /mobile|phone/i.test(x.Device))) {
      const r = rutaDe(x.URL), previo = movil.get(r);
      movil.set(r, previo ? juntar([previo, x]) : x);
    }
    const propios = new Map();
    try {
      const desdeTs = new Date(`${desde}T06:00:00Z`).toISOString();
      const filas = await sb('/rest/v1/rpc/comportamiento_paginas', { method: 'POST', body: JSON.stringify({ p_desde: desdeTs, p_hasta: new Date().toISOString() }) });
      for (const f of filas || []) propios.set(f.path, f);
    } catch (e) { out.aviso_propios = e.message; }
    const porRuta = new Map();
    for (const p of paginas) {
      const ruta = rutaDe(p.URL);
      const previo = porRuta.get(ruta);
      porRuta.set(ruta, previo ? { ...juntar([previo, p]), URL: ruta } : { ...p, URL: ruta });
    }
    out.paginas = [...porRuta.values()].slice(0, 40).map(p => {
      const m = movil.get(p.URL), o = propios.get(p.URL);
      return {
        ruta: p.URL, sesiones: p.sesiones, scroll: p.scroll, tiempo_activo: p.tiempo_activo,
        clics_inactivos: p.clics_inactivos, clics_ira: p.clics_ira, regresos_rapidos: p.regresos_rapidos, errores_js: p.errores_js,
        scroll_movil: m ? m.scroll : null,
        visitas_propias: o ? Number(o.visitas) : null,
        carrito_pct: o && Number(o.visitas) ? Math.round(Number(o.carrito) / Number(o.visitas) * 1000) / 10 : null,
        compra_pct: o && Number(o.visitas) ? Math.round(Number(o.compra) / Number(o.visitas) * 1000) / 10 : null,
        lcp_movil: o && o.lcp_movil != null ? Number(o.lcp_movil) : null
      };
    });
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo armar el reporte', detail: e.message });
  }
};
module.exports = Object.assign(handler, { __test: { juntar, porDimension, rutaDe } });
