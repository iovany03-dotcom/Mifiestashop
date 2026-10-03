// Vercel Cron (ver vercel.json "crons"): recorre el catálogo activo poco a poco y busca la
// competencia de cada producto en Mercado Libre (lib/competencia-ml.js). Cursor por id en
// ps_sync_estado (dominio 'competencia_ml'); al terminar el catálogo vuelve a empezar, así los
// precios se refrescan solos cada pocos días.
const { buscarCompetenciaML, guardarCompetenciaML } = require('../lib/competencia-ml.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const POR_CORRIDA = 40;
const TIEMPO_MAX_MS = 50000;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (expected && (req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== expected) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  if (!process.env.ML_ACCESS_TOKEN && !(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET)) {
    res.status(200).json({ skipped: true, reason: 'Faltan ML_CLIENT_ID / ML_CLIENT_SECRET' }); return;
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY' }); return; }
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  try {
    const st = await fetch(`${SUPABASE_URL}/rest/v1/ps_sync_estado?dominio=eq.competencia_ml&select=last_synced_id`, { headers: h });
    const desde = Number(((await st.json())[0] || {}).last_synced_id) || 0;
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/catalogo_productos?select=id,name,price&active=eq.true&id=gt.${desde}&order=id.asc&limit=${POR_CORRIDA}`, { headers: h });
    if (!pr.ok) throw new Error(`leer catalogo_productos -> HTTP ${pr.status}`);
    const productos = await pr.json();
    const inicio = Date.now();
    let cursor = desde, hechos = 0, conCompetencia = 0, fallidos = 0, primerError = null;
    for (const p of productos) {
      if (Date.now() - inicio > TIEMPO_MAX_MS) break;
      try {
        const { resultados } = await buscarCompetenciaML(p);
        await guardarCompetenciaML({ supabaseUrl: SUPABASE_URL, serviceKey, id: p.id, resultados });
        if (resultados.length) conCompetencia++;
      } catch (e) {
        fallidos++; if (!primerError) primerError = `id ${p.id}: ${e.message}`;
      }
      hechos++; cursor = p.id;
    }
    const termino = productos.length < POR_CORRIDA && hechos === productos.length;
    const resumen = `${termino ? 'vuelta completa' : 'parcial'}: ${hechos} buscados, ${conCompetencia} con competencia, ${fallidos} fallidos${primerError ? ' — ' + primerError : ''}`.slice(0, 300);
    await fetch(`${SUPABASE_URL}/rest/v1/ps_sync_estado?on_conflict=dominio`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ dominio: 'competencia_ml', last_synced_id: termino ? 0 : cursor, last_synced_at: new Date().toISOString(), ultimo_resultado: resumen })
    });
    res.status(200).json({ ok: true, desde, hasta: cursor, hechos, conCompetencia, fallidos, termino });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
