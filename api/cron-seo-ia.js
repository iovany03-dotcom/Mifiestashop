// Vercel Cron (vercel.json, cada 10 minutos): la IA propone título SEO, meta descripción y
// descripción para los productos de la cola (lib/seo-cola.js); se aprueban en el módulo SEO.
//
// Usa crédito de OpenAI/Anthropic, así que tiene su propio candado en ps_sync_estado
// (dominio 'seo_ia'): si la última corrida empezó hace menos de 8 minutos no hace nada, aunque
// alguien llame la URL muchas veces (CRON_SECRET no está configurado en este proyecto).
// SEO_IA_PAUSA=1 en Vercel la detiene sin quitar el cron.
const { sb } = require('../lib/seo-datos.js');
const cola = require('../lib/seo-cola.js');

const ESPERA_MIN_MS = 8 * 60 * 1000;
const MAX_SIN_REVISAR = 150;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (expected && (req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (process.env.SEO_IA_PAUSA === '1') { res.status(200).json({ ok: true, pausado: true }); return; }
  if (!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) { res.status(200).json({ ok: true, sin_ia: true }); return; }
  try {
    const [estado] = await sb('/rest/v1/ps_sync_estado?dominio=eq.seo_ia&select=last_synced_at,last_synced_id');
    const ultima = estado && estado.last_synced_at ? new Date(estado.last_synced_at).getTime() : 0;
    if (Date.now() - ultima < ESPERA_MIN_MS) { res.status(200).json({ ok: true, omitido: 'corrió hace menos de 8 minutos' }); return; }
    // last_synced_id guarda el día (AAAAMMDD) en que se revisó el catálogo por última vez.
    const hoy = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    let dia = Number(estado && estado.last_synced_id) || 0;
    const guardar = (resultado) => sb('/rest/v1/ps_sync_estado?on_conflict=dominio', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ dominio: 'seo_ia', last_synced_id: dia, last_synced_at: new Date().toISOString(), ultimo_resultado: resultado }])
    });
    await guardar('corriendo');

    let llenado = null;
    const r0 = await cola.resumen();
    // Se vuelve a revisar el catálogo cuando la cola se vacía o una vez al día (productos nuevos).
    if (!r0.total || dia !== hoy) {
      llenado = await cola.llenar();
      dia = hoy;
    }
    // Si ya hay muchas propuestas sin revisar, no se gasta más crédito hasta que se aprueben.
    if (r0.propuesto >= MAX_SIN_REVISAR) {
      await guardar(`En espera: ${r0.propuesto} propuestas por revisar en SEO → Productos`);
      res.status(200).json({ ok: true, llenado, en_espera: true, cola: r0 });
      return;
    }
    const hecho = await cola.procesar({ tiempoMaxMs: 240000 });
    const r = await cola.resumen();
    await guardar(`${hecho.propuestos} propuestas, ${hecho.errores} errores · por revisar ${r.propuesto}, pendientes ${r.pendiente}`);
    res.status(200).json({ ok: true, llenado, ...hecho, cola: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
