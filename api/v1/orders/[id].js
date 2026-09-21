// API pública /api/v1/orders/:id
// GET   scope orders:read
// PATCH scope orders:write — solo permite cambiar "status" (a uno de los
// valores válidos, los mismos que usa el panel de administración). Otros
// campos del pedido no se aceptan aquí: se congelan en la creación, igual
// que en el checkout público.
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const VALID_STATUSES = ['Pendiente', 'Pagado', 'Pago Aceptado', 'Enviado', 'Entregado', 'Cancelado'];

function toPublicOrder(o) {
  return {
    id: Number(o.id), folio: o.folio, created_at: o.created_at, status: o.status,
    customer_name: o.customer_name, customer_email: o.customer_email, customer_phone: o.customer_phone,
    shipping_address: o.shipping_address, shipping_cost: o.shipping_cost !== null ? Number(o.shipping_cost) : undefined,
    payment_method: o.payment_method || undefined,
    items: Array.isArray(o.items) ? o.items : [],
    subtotal: Number(o.subtotal), total: Number(o.total)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const id = parseInt(req.query.id, 10);
  if (!id) return sendApiError(res, 400, 'id inválido.', 'invalid_id');

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');
  const select = 'id,folio,created_at,status,customer_name,customer_email,customer_phone,shipping_address,shipping_cost,payment_method,items,subtotal,total';

  if (req.method === 'GET') {
    const auth = await authenticateApiRequest(req, 'orders:read');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?id=eq.${id}&select=${select}`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      });
      if (!r.ok) return sendApiError(res, 502, 'No se pudo consultar el pedido.', 'upstream_error');
      const rows = await r.json();
      const o = Array.isArray(rows) && rows[0];
      if (!o) return sendApiError(res, 404, 'Pedido no encontrado.', 'not_found');
      res.status(200).json({ data: toPublicOrder(o) });
    } catch (err) {
      sendApiError(res, 500, 'Error al consultar el pedido: ' + err.message, 'internal_error');
    }
    return;
  }

  if (req.method === 'PATCH') {
    const auth = await authenticateApiRequest(req, 'orders:write');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!body.status || !VALID_STATUSES.includes(body.status)) {
      return sendApiError(res, 422, `"status" debe ser uno de: ${VALID_STATUSES.join(', ')}.`, 'invalid_status');
    }
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ status: body.status })
      });
      if (!r.ok) return sendApiError(res, 502, 'No se pudo actualizar el pedido.', 'upstream_error');
      const rows = await r.json();
      const o = Array.isArray(rows) && rows[0];
      if (!o) return sendApiError(res, 404, 'Pedido no encontrado.', 'not_found');
      res.status(200).json({ data: toPublicOrder(o) });
    } catch (err) {
      sendApiError(res, 500, 'Error al actualizar el pedido: ' + err.message, 'internal_error');
    }
    return;
  }

  sendApiError(res, 405, 'Método no permitido. Usa GET o PATCH.', 'method_not_allowed');
};
