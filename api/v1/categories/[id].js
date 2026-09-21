// API pública /api/v1/categories/:id — detalle de una categoría.
// Scope requerido: categories:read
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

  const id = parseInt(req.query.id, 10);
  if (!id) return sendApiError(res, 400, 'id inválido.', 'invalid_id');

  const auth = await authenticateApiRequest(req, 'categories:read');
  if (!auth.ok) return sendApiError(res, auth.status, auth.error);

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ps_categorias?id=eq.${id}&active=eq.true&select=id,name,id_parent`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!r.ok) return sendApiError(res, 502, 'No se pudo consultar la categoría.', 'upstream_error');
    const rows = await r.json();
    const c = Array.isArray(rows) && rows[0];
    if (!c) return sendApiError(res, 404, 'Categoría no encontrada.', 'not_found');
    res.status(200).json({ data: { id: Number(c.id), name: normalizeCategoryName(c.name), parent_id: c.id_parent != null ? Number(c.id_parent) : undefined } });
  } catch (err) {
    sendApiError(res, 500, 'Error al consultar la categoría: ' + err.message, 'internal_error');
  }
};
