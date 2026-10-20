// Vercel Cron (vercel.json "crons", cada hora): mantiene al día el módulo SEO.
//   1) Audita las siguientes POR_CORRIDA URLs del sitemap (cursor en ps_sync_estado, dominio
//      'seo_auditoria'); al terminar el sitemap vuelve a empezar: todo el sitio se revisa ~1 vez al día.
//   2) Una vez al día (la primera corrida sin registro de hoy): guarda en seo_historial el puntaje
//      del sitio y, si Search Console está conectado, las consultas del día en seo_gsc_diario.
//   3) Una vez al día, si hay PAGESPEED_API_KEY: mide la velocidad del inicio en celular.
const { auditarUrl } = require('../lib/seo-auditor.js');
const google = require('../lib/seo-google.js');
const { sb, sbTodo, guardarAuditorias, urlsDelSitemap, productosConPuntaje, promedio, ORIGEN } = require('../lib/seo-datos.js');

const POR_CORRIDA = 70;
const PARALELO = 5;
const TIEMPO_MAX_MS = 200000;

async function cursor() {
  const r = await sb('/rest/v1/ps_sync_estado?dominio=eq.seo_auditoria&select=last_synced_id');
  return Number((r[0] || {}).last_synced_id) || 0;
}
async function guardarCursor(n, resultado) {
  await sb('/rest/v1/ps_sync_estado?on_conflict=dominio', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ dominio: 'seo_auditoria', last_synced_id: n, last_synced_at: new Date().toISOString(), ultimo_resultado: resultado }])
  });
}

async function auditarTanda(inicio) {
  const urls = await urlsDelSitemap();
  const desde = inicio >= urls.length ? 0 : inicio;
  const tanda = urls.slice(desde, desde + POR_CORRIDA);
  const t0 = Date.now();
  let hechas = 0;
  for (let i = 0; i < tanda.length && Date.now() - t0 < TIEMPO_MAX_MS; i += PARALELO) {
    const resultados = await Promise.all(tanda.slice(i, i + PARALELO).map(u => auditarUrl(u)));
    await guardarAuditorias(resultados);
    hechas += resultados.length;
  }
  const siguiente = desde + hechas >= urls.length ? 0 : desde + hechas;
  await guardarCursor(siguiente, `${hechas} URLs auditadas (${desde + 1}-${desde + hechas} de ${urls.length})`);
  return { auditadas: hechas, desde, total_sitemap: urls.length };
}

async function fotoDiaria() {
  const hoy = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); // día en hora de México
  const ya = await sb(`/rest/v1/seo_historial?fecha=eq.${hoy}&select=fecha`);
  if (ya.length) return { foto: 'ya existía' };
  const [auds, prods] = await Promise.all([sbTodo('/rest/v1/seo_auditorias?select=puntaje'), productosConPuntaje()]);
  const fila = {
    fecha: hoy,
    puntaje_paginas: promedio(auds.map(a => a.puntaje)), paginas: auds.length,
    puntaje_productos: promedio(prods.map(p => p.puntaje)), productos: prods.length,
    detalle: {}
  };
  const out = { foto: hoy };
  if (google.gscConfigurado()) {
    try {
      const { endDate } = google.rango(1);
      const tot = await google.analitica({ startDate: endDate, endDate, dimensiones: [], limite: 1 });
      if (tot[0]) Object.assign(fila, { clics: tot[0].clics, impresiones: tot[0].impresiones, posicion: tot[0].posicion });
      const filas = await google.analitica({ startDate: endDate, endDate, dimensiones: ['query', 'page'], limite: 5000 });
      for (let i = 0; i < filas.length; i += 1000) {
        await sb('/rest/v1/seo_gsc_diario?on_conflict=fecha,consulta,pagina', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(filas.slice(i, i + 1000).map(r => ({ fecha: endDate, consulta: r.keys[0].slice(0, 300), pagina: r.keys[1].slice(0, 500), clics: r.clics, impresiones: r.impresiones, ctr: r.ctr, posicion: r.posicion })))
        });
      }
      out.gsc_filas = filas.length;
    } catch (e) { out.gsc_error = e.message; fila.detalle.gsc_error = e.message.slice(0, 300); }
  }
  await sb('/rest/v1/seo_historial?on_conflict=fecha', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([fila]) });
  if (process.env.PAGESPEED_API_KEY) {
    try {
      const r = await google.pagespeed(`${ORIGEN}/`, 'mobile');
      await sb('/rest/v1/seo_pagespeed', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([r]) });
      out.pagespeed = r.performance;
    } catch (e) { out.pagespeed_error = e.message; }
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (expected && (req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== expected) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  try {
    const tanda = await auditarTanda(await cursor());
    const foto = await fotoDiaria();
    res.status(200).json({ ok: true, ...tanda, ...foto });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
