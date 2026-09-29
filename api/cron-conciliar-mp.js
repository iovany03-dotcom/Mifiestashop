// Vercel Cron (cada 15 min, ver vercel.json "crons"): revisa en Mercado
// Pago los pedidos web de los últimos 7 días que siguen en "Pendiente",
// "Pendiente de pago" o "Error en el pago" (sin motivo guardado) y les
// aplica su pago real (lib/mp-pago.js conciliarPedido). Así un pedido
// pagado nunca se queda como pendiente porque el aviso (webhook) de
// Mercado Pago no llegó, y los rechazos quedan con su motivo.
//
// GET -> { revisados, conIntentos, sinIntentos, resultados: [...] }
const { conciliarPedido } = require('../lib/mp-pago.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const MAX_PEDIDOS = 40;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Mismo criterio que api/cron-sync-prestashop.js: con CRON_SECRET, solo
  // Vercel Cron (o quien lo conozca).
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (got !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }
  }

  const accessToken = process.env.MP_ACCESS_TOKEN;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!accessToken || !serviceRoleKey) { res.status(200).json({ skipped: true, reason: 'Falta MP_ACCESS_TOKEN o SUPABASE_SERVICE_ROLE_KEY' }); return; }

  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Se deja pasar 10 min desde que se creó el pedido: el cliente puede
  // estar todavía en la página de Mercado Pago.
  const hasta = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const filtro = `payment_method=eq.Mercado%20Pago&created_at=gte.${desde}&created_at=lte.${hasta}` +
    `&or=(status.in.(Pendiente,%22Pendiente%20de%20pago%22),and(status.eq.%22Error%20en%20el%20pago%22,mp_status_detail.is.null))`;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?${filtro}&select=folio&order=created_at.desc&limit=${MAX_PEDIDOS}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!r.ok) throw new Error(`pedidos_online -> HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const pedidos = await r.json();
    const resultados = [];
    for (const { folio } of pedidos) {
      try {
        const c = await conciliarPedido({ accessToken, serviceRoleKey, folio });
        resultados.push({ folio, intentos: c.intentos.length, estado: c.aplicado ? c.aplicado.estado : null, detalle: c.intentos[0] ? c.intentos[0].statusDetail : null });
      } catch (e) {
        resultados.push({ folio, error: e.message });
      }
    }
    res.status(200).json({
      revisados: resultados.length,
      conIntentos: resultados.filter(x => x.intentos > 0).length,
      sinIntentos: resultados.filter(x => x.intentos === 0).length,
      resultados
    });
  } catch (e) {
    console.error('cron-conciliar-mp:', e.message);
    res.status(500).json({ error: e.message });
  }
};
