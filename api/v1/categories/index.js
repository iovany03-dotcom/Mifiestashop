// API pública /api/v1/categories — lista de categorías, autenticada con
// API key. Scope requerido: categories:read
//
// Solo lectura: la escritura de categorías (jerarquía, nombres en varios
// idiomas) es una de las partes más frágiles del webservice real de
// PrestaShop, y este sitio ya sincroniza ps_categorias cada hora desde la
// fuente real — no tiene caso duplicar esa responsabilidad aquí. Ver la
// página de documentación para el detalle de esta decisión.
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

function normalizeCategoryName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return sendApiError(res, 405, 'Método no permitido. Usa GET.', 'method_not_allowed');

  const auth = await authenticateApiRequest(req, 'categories:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ps_categorias?active=eq.true&select=id,name,id_parent&order=name.asc`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!r.ok) return sendApiError(res, 502, 'No se pudo consultar categorías.', 'upstream_error');
    const rows = await r.json();
    const all = (Array.isArray(rows) ? rows : []).map(c => ({
      id: Number(c.id), name: normalizeCategoryName(c.name), parent_id: c.id_parent != null ? Number(c.id_parent) : undefined
    }));
    const page = all.slice(offset, offset + limit);
    res.status(200).json({ data: page, meta: { total: all.length, limit, offset } });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar categorías: ' + err.message, 'internal_error');
  }
};
