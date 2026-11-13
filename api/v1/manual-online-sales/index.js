// API pública /api/v1/manual-online-sales (scope manual-online-sales:read)
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Devuelve, por día y por quién lo capturó, el total de pedidos de
// pedidos_online con source = 'manual' (un asesor lo tecleó a mano:
// WhatsApp, teléfono, etc.) dentro del rango. A propósito EXCLUYE:
//   - source = 'checkout' (el cliente pagó solo vía Mercado Pago)
//   - status = 'Cancelado' (no es una venta real)
// Existe para que un sistema externo (nómina) pueda pagar comisión
// individual por ventas en línea solo a quien de verdad las generó,
// sin mezclar los pagos automáticos de Mercado Pago.
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return sendApiError(res, 405, 'Método no permitido. Usa GET.', 'method_not_allowed');
  }

  const auth = await authenticateApiRequest(req, 'manual-online-sales:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  const { from, to } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return sendApiError(res, 400, 'Parámetros requeridos: from, to (YYYY-MM-DD).', 'invalid_params');
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');

  try {
    const url = `${SUPABASE_URL}/rest/v1/pedidos_online?select=created_by,created_at,total,status&source=eq.manual` +
      `&status=neq.Cancelado` +
      `&created_at=gte.${encodeURIComponent(from + 'T00:00:00-06:00')}` +
      `&created_at=lte.${encodeURIComponent(to + 'T23:59:59-06:00')}&limit=10000`;
    const r = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
    if (!r.ok) return sendApiError(res, 502, 'No se pudo consultar pedidos_online.', 'upstream_error');
    const rows = await r.json();

    const buckets = {}; // `${created_by}|${YYYY-MM-DD}` -> revenue

    rows.forEach(o => {
      const createdBy = (o.created_by || '').trim();
      if (!createdBy) return;
      const local = new Date(o.created_at).toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' });
      const dateISO = local.slice(0, 10);
      const key = `${createdBy}|${dateISO}`;
      buckets[key] = (buckets[key] || 0) + parseFloat(o.total || 0);
    });

    const data = Object.entries(buckets)
      .map(([key, revenue]) => {
        const [createdBy, date] = key.split('|');
        return { created_by: createdBy, date, revenue: Math.round(revenue * 100) / 100 };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.created_by.localeCompare(b.created_by));

    res.status(200).json({
      data, from, to,
      note: 'Solo pedidos capturados a mano (source=manual), sin cancelados. Excluye checkout/Mercado Pago a propósito.',
    });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar ventas en línea manuales: ' + err.message, 'internal_error');
  }
};
