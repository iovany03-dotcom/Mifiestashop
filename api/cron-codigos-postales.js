// Vercel Cron (vercel.json, mensual) — carga el Catálogo Nacional de Códigos Postales de
// Correos de México (SEPOMEX) en la tabla codigos_postales, agrupado por CP (estado, municipio,
// ciudad y colonias). El checkout lo usa para llenar solo estado, municipio y colonia con el
// código postal (función buscar_cp; la tabla no se puede leer completa desde fuera).
//
// Candado en ps_sync_estado ('codigos_postales'): solo vuelve a cargar si la tabla está vacía o
// pasaron 25 días, aunque alguien llame la URL muchas veces.
const { sb } = require('../lib/seo-datos.js');

const URL_CATALOGO = 'https://www.correosdemexico.gob.mx/datosabiertos/cp/cpdescarga.txt';
const DIAS = 25;

// Texto del archivo -> [{ cp, estado, municipio, ciudad, colonias[] }]
function agrupar(texto) {
  const lineas = texto.split(/\r?\n/);
  const iCab = lineas.findIndex(l => l.startsWith('d_codigo|'));
  if (iCab < 0) throw new Error('El catálogo no tiene el encabezado esperado (d_codigo|...).');
  const cab = lineas[iCab].split('|');
  const col = k => cab.indexOf(k);
  const [cCp, cAs, cMun, cEst, cCiu] = ['d_codigo', 'd_asenta', 'D_mnpio', 'd_estado', 'd_ciudad'].map(col);
  const porCp = new Map();
  for (const l of lineas.slice(iCab + 1)) {
    const c = l.split('|');
    const cp = (c[cCp] || '').trim();
    if (!/^\d{5}$/.test(cp)) continue;
    let e = porCp.get(cp);
    if (!e) { e = { cp, estado: (c[cEst] || '').trim(), municipio: (c[cMun] || '').trim(), ciudad: (c[cCiu] || '').trim() || null, colonias: [] }; porCp.set(cp, e); }
    const a = (c[cAs] || '').trim();
    if (a && !e.colonias.includes(a)) e.colonias.push(a);
  }
  return [...porCp.values()];
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (expected && (req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    const [estado] = await sb('/rest/v1/ps_sync_estado?dominio=eq.codigos_postales&select=last_synced_at');
    const [hay] = await sb('/rest/v1/codigos_postales?select=cp&limit=1');
    const ultima = estado && estado.last_synced_at ? new Date(estado.last_synced_at).getTime() : 0;
    if (hay && Date.now() - ultima < DIAS * 86400000) { res.status(200).json({ ok: true, omitido: `ya se cargó hace menos de ${DIAS} días` }); return; }
    const marcar = resultado => sb('/rest/v1/ps_sync_estado?on_conflict=dominio', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ dominio: 'codigos_postales', last_synced_id: 0, last_synced_at: new Date().toISOString(), ultimo_resultado: resultado }])
    });
    await marcar('cargando');

    const r = await fetch(URL_CATALOGO, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Correos de México respondió HTTP ${r.status}`);
    const texto = new TextDecoder('latin1').decode(await r.arrayBuffer());
    const filas = agrupar(texto);
    if (filas.length < 20000) throw new Error(`El catálogo trae muy pocos códigos postales (${filas.length}); no se reemplaza.`);
    for (let i = 0; i < filas.length; i += 1000) {
      await sb('/rest/v1/codigos_postales?on_conflict=cp', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(filas.slice(i, i + 1000)) });
    }
    await marcar(`${filas.length} códigos postales cargados`);
    res.status(200).json({ ok: true, codigos_postales: filas.length });
  } catch (e) {
    // Sin candado: si falló a la mitad, la siguiente llamada vuelve a intentar.
    await sb('/rest/v1/ps_sync_estado?on_conflict=dominio', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ dominio: 'codigos_postales', last_synced_id: 0, last_synced_at: new Date(0).toISOString(), ultimo_resultado: `Error: ${String(e.message).slice(0, 200)}` }]) }).catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.agrupar = agrupar;
