// API pública /api/v1/customers/:id — detalle de un cliente.
// Scope requerido: customers:read
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

function toPublicCustomer(c) {
  return {
    id: Number(c.id), name: c.name, email: c.email, phone: c.phone || undefined,
    company: c.company || undefined, address: c.address || undefined, city: c.city || undefined,
    postcode: c.postcode || undefined, is_guest: !!c.is_guest, created_at: c.date_add
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return sendApiError(res, 405, 'Método no permitido. Usa GET.', 'method_not_allowed');

  const id = parseInt(req.query.id, 10);
  if (!id) return sendApiError(res, 400, 'id inválido.', 'invalid_id');

  const auth = await authenticateApiRequest(req, 'customers:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');

  try {
    const select = 'id,name,email,phone,company,address,city,postcode,is_guest,date_add';
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ps_clientes?id=eq.${id}&active=eq.true&select=${select}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!r.ok) return sendApiError(res, 502, 'No se pudo consultar el cliente.', 'upstream_error');
    const rows = await r.json();
    const c = Array.isArray(rows) && rows[0];
    if (!c) return sendApiError(res, 404, 'Cliente no encontrado.', 'not_found');
    res.status(200).json({ data: toPublicCustomer(c) });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar el cliente: ' + err.message, 'internal_error');
  }
};
