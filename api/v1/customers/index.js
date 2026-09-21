// API pública /api/v1/customers — lista de clientes, autenticada con API key.
// Scope requerido: customers:read
//
// Solo lectura por ahora: ps_clientes es una copia sincronizada desde
// PrestaShop (no al revés), y no se ha probado en este proyecto crear
// clientes reales contra el webservice real de PrestaShop — mejor no
// prometer una escritura que no se puede garantizar. Ver la página de
// documentación para el detalle de esta decisión y el plan a futuro.
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

  const auth = await authenticateApiRequest(req, 'customers:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = (req.query.search || '').trim();

  try {
    const select = 'id,name,email,phone,company,address,city,postcode,is_guest,date_add';
    let url = `${SUPABASE_URL}/rest/v1/ps_clientes?active=eq.true&select=${select}&order=date_add.desc&limit=${limit}&offset=${offset}`;
    if (search) url += `&or=(name.ilike.*${encodeURIComponent(search)}*,email.ilike.*${encodeURIComponent(search)}*)`;
    const r = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Prefer: 'count=exact' } });
    if (!r.ok) return sendApiError(res, 502, 'No se pudieron consultar los clientes.', 'upstream_error');
    const rows = await r.json();
    const range = r.headers.get('content-range');
    const total = range && range.includes('/') ? parseInt(range.split('/')[1], 10) : rows.length;
    res.status(200).json({ data: rows.map(toPublicCustomer), meta: { total: Number.isFinite(total) ? total : rows.length, limit, offset } });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar clientes: ' + err.message, 'internal_error');
  }
};
