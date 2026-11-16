// API pública /api/v1/branch-sales (scope branch-sales:read)
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Devuelve el total vendido FÍSICAMENTE en cada sucursal, por día, a partir
// de ps_pedidos (histórico PrestaShop, por caja) y pos_tickets (POS propio).
// A propósito NUNCA incluye pedidos_online (checkout de la tienda en línea):
// este endpoint existe justo para que un sistema externo (nómina) pueda medir
// metas de venta de piso sin mezclar ventas en línea.
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const STORE_BY_EMPLOYEE = { 225: 'CDMX Rumania', 226: 'Querétaro', 230: 'Puebla', 227: 'Atizapán' };

// Los tickets del POS propio guardan la sucursal como el texto del selector
// del POS ("Bodega Principal (Rumania)", "Puebla", "Querétaro"...); se
// agrupan con el id de la caja de esa sucursal, igual que api/ventas.js.
function ticketEmployeeId(almacen) {
  const n = String(almacen || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/rumania|cdmx|popocatepetl/.test(n)) return 225;
  if (/queretaro/.test(n)) return 226;
  if (/puebla/.test(n)) return 230;
  if (/atizapan/.test(n)) return 227;
  return -1;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return sendApiError(res, 405, 'Método no permitido. Usa GET.', 'method_not_allowed');
  }

  const auth = await authenticateApiRequest(req, 'branch-sales:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  const { from, to } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return sendApiError(res, 400, 'Parámetros requeridos: from, to (YYYY-MM-DD).', 'invalid_params');
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');

  const fromDt = `${from} 00:00:00`;
  const toDt = `${to} 23:59:59`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };

  try {
    // Pedidos históricos de PrestaShop por caja (id_employee = 0 es tienda en
    // línea, se excluye con neq.0). date_add ya está en hora local de la tienda.
    const r1 = await fetch(
      `${SUPABASE_URL}/rest/v1/ps_pedidos?select=total_paid,date_add,id_employee&valid=is.true&or=(id_currency.eq.3,id_currency.is.null)` +
      `&date_add=gte.${encodeURIComponent(fromDt)}&date_add=lte.${encodeURIComponent(toDt)}&id_employee=neq.0&limit=10000`,
      { headers }
    );
    if (!r1.ok) return sendApiError(res, 502, 'No se pudo consultar ps_pedidos.', 'upstream_error');
    const psOrders = await r1.json();

    // Tickets del POS propio. Los que ya tienen pedido en PrestaShop
    // (ps_order_id) están contados arriba: se excluyen para no duplicar.
    const r2 = await fetch(
      `${SUPABASE_URL}/rest/v1/pos_tickets?select=total,almacen,created_at&ps_order_id=is.null` +
      `&created_at=gte.${encodeURIComponent(from + 'T00:00:00-06:00')}` +
      `&created_at=lte.${encodeURIComponent(to + 'T23:59:59-06:00')}&limit=10000`,
      { headers }
    );
    if (!r2.ok) return sendApiError(res, 502, 'No se pudo consultar pos_tickets.', 'upstream_error');
    const tickets = await r2.json();

    const buckets = {}; // `${storeId}|${YYYY-MM-DD}` -> revenue

    psOrders.forEach(o => {
      const id = parseInt(o.id_employee, 10) || 0;
      if (!STORE_BY_EMPLOYEE[id]) return;
      const dateISO = String(o.date_add || '').slice(0, 10);
      if (!dateISO) return;
      const key = `${id}|${dateISO}`;
      buckets[key] = (buckets[key] || 0) + parseFloat(o.total_paid || 0);
    });

    tickets.forEach(t => {
      const id = ticketEmployeeId(t.almacen);
      if (!STORE_BY_EMPLOYEE[id]) return;
      const local = new Date(t.created_at).toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' });
      const dateISO = local.slice(0, 10);
      const key = `${id}|${dateISO}`;
      buckets[key] = (buckets[key] || 0) + parseFloat(t.total || 0);
    });

    const data = Object.entries(buckets)
      .map(([key, revenue]) => {
        const [storeId, date] = key.split('|');
        return {
          store_id: Number(storeId),
          store: STORE_BY_EMPLOYEE[storeId],
          date,
          revenue: Math.round(revenue * 100) / 100,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.store_id - b.store_id);

    res.status(200).json({ data, from, to, note: 'Solo ventas físicas (ps_pedidos + pos_tickets). pedidos_online (tienda en línea) queda excluido a propósito.' });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar ventas físicas: ' + err.message, 'internal_error');
  }
};
