// Autenticación para la API pública /api/v1/* — llaves tipo "mfs_live_..."
// (como el ws_key de PrestaShop, pero por Bearer token en vez de Basic Auth,
// y por scope en vez de un único permiso de lectura/escritura/borrado
// global). Nunca se guarda la llave en texto plano: solo su hash sha256, y
// solo esta función la verifica, con la llave de servicio (la tabla
// api_keys no tiene política de SELECT para anon/authenticated).
const crypto = require('node:crypto');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// scope requerido, ej. "products:read" — una llave con el scope "*" (admin)
// pasa cualquier verificación.
async function authenticateApiRequest(req, requiredScope) {
  const auth = req.headers['authorization'] || '';
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!match) {
    return { ok: false, status: 401, error: 'Falta el header Authorization: Bearer <api_key>.' };
  }
  const rawKey = match[1];
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return { ok: false, status: 500, error: 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.' };
  }

  try {
    const keyHash = hashKey(rawKey);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}&select=id,nombre,scopes,activo`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
    );
    if (!r.ok) return { ok: false, status: 500, error: 'No se pudo verificar la llave.' };
    const rows = await r.json();
    const key = Array.isArray(rows) && rows[0];
    if (!key || !key.activo) {
      return { ok: false, status: 401, error: 'API key inválida o revocada.' };
    }
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    if (requiredScope && !scopes.includes('*') && !scopes.includes(requiredScope)) {
      return { ok: false, status: 403, error: `Esta API key no tiene el scope "${requiredScope}".` };
    }
    // Best-effort, no bloquea la respuesta si falla.
    fetch(`${SUPABASE_URL}/rest/v1/api_keys?id=eq.${key.id}`, {
      method: 'PATCH',
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_used_at: new Date().toISOString() })
    }).catch(() => {});
    return { ok: true, key: { id: key.id, nombre: key.nombre, scopes } };
  } catch (e) {
    return { ok: false, status: 500, error: 'Error al verificar la llave: ' + e.message };
  }
}

// Respuesta de error consistente para toda /api/v1/* (mismo formato que
// PrestaShop no usa, pero mucho más claro: siempre { error: { code, message } }).
function sendApiError(res, status, message, code) {
  res.status(status).json({ error: { code: code || String(status), message } });
}

module.exports = { authenticateApiRequest, sendApiError, hashKey };
