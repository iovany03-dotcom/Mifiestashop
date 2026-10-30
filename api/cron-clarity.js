// Vercel Cron (vercel.json, diario 00:35 de México): guarda en clarity_diario el resumen de las
// últimas 24 h de Microsoft Clarity (lib/clarity.js, 6 consultas de las 10 que permite al día).
//
// Candado en ps_sync_estado ('clarity'): solo una vez por día. Así, aunque alguien llame la URL
// muchas veces (CRON_SECRET no está configurado), no se agotan las consultas de Clarity.
const { sb } = require('../lib/seo-datos.js');
const clarity = require('../lib/clarity.js');

const fechaMx = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (expected && (req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!process.env.CLARITY_API_TOKEN) { res.status(200).json({ ok: true, sin_token: true }); return; }
  // Las últimas 24 h se anotan como el día de México que acaba de terminar (corre a las 00:35).
  const fecha = fechaMx(new Date(Date.now() - 12 * 3600e3));
  const hoyNum = Number(fechaMx().replace(/-/g, ''));
  try {
    const [estado] = await sb('/rest/v1/ps_sync_estado?dominio=eq.clarity&select=last_synced_id');
    if (estado && Number(estado.last_synced_id) === hoyNum) { res.status(200).json({ ok: true, omitido: 'ya se consultó hoy' }); return; }
    const marcar = resultado => sb('/rest/v1/ps_sync_estado?on_conflict=dominio', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ dominio: 'clarity', last_synced_id: hoyNum, last_synced_at: new Date().toISOString(), ultimo_resultado: resultado }])
    });
    await marcar('consultando');
    const hechas = [], errores = [];
    for (const dims of clarity.CONSULTAS) {
      try {
        const datos = await clarity.consultar(dims, 1);
        await sb('/rest/v1/clarity_diario?on_conflict=fecha,dimension', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ fecha, dimension: dims.join(','), datos, obtenido_at: new Date().toISOString() }])
        });
        hechas.push(dims.join(',') || 'total');
      } catch (e) {
        errores.push(`${dims.join(',') || 'total'}: ${e.message}`);
        if (e.status === 401 || e.status === 403 || e.status === 429) break; // token malo o sin consultas: no seguir
      }
    }
    await marcar(`${fecha}: ${hechas.length} consultas guardadas${errores.length ? ` · errores: ${errores.join(' / ').slice(0, 300)}` : ''}`);
    res.status(errores.length && !hechas.length ? 502 : 200).json({ ok: !errores.length, fecha, hechas, errores });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
