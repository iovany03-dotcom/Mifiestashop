// Sesión del panel para las rutas /api que devuelven datos privados (clientes, ventas, pedidos,
// existencias por sucursal, proveedores...). El panel manda las mismas credenciales que ya usa
// con Supabase (getSessionCredsParams en index.html) en el header "x-mfs-sesion" (JSON en
// base64) o en el cuerpo como { creds }. Se validan con panel_sesion (solo service_role).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

class SesionError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function credsDe(req) {
  const h = req.headers && (req.headers['x-mfs-sesion'] || req.headers['X-Mfs-Sesion']);
  if (h) {
    try { return JSON.parse(Buffer.from(String(h), 'base64').toString('utf8')); } catch (e) { return null; }
  }
  const b = req.body && typeof req.body === 'object' ? req.body : null;
  return b && b.creds && typeof b.creds === 'object' ? b.creds : null;
}

// permisos: lista de llaves de permiso; basta con tener una. Vacía = cualquier persona del
// equipo con sesión válida. El administrador siempre pasa.
async function sesionPanel(req, permisos = []) {
  const c = credsDe(req) || {};
  if (!c.p_admin_password && !(c.p_staff_email && c.p_staff_pin)) throw new SesionError(401, 'Inicia sesión en el panel.');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new SesionError(500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/panel_sesion`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: c.p_admin_password ?? null, p_staff_email: c.p_staff_email ?? null, p_staff_pin: c.p_staff_pin ?? null })
  });
  if (!r.ok) throw new SesionError(500, 'No se pudo verificar la sesión.');
  const d = await r.json();
  const fila = Array.isArray(d) ? d[0] : d;
  if (!fila || !fila.nombre) throw new SesionError(401, 'Sesión no válida. Vuelve a iniciar sesión.');
  const tiene = Array.isArray(fila.permisos) ? k => fila.permisos.includes(k) : k => !!(fila.permisos && fila.permisos[k]);
  if (!fila.es_admin && permisos.length && !permisos.some(tiene)) throw new SesionError(403, 'Tu usuario no tiene permiso para ver esto.');
  return fila;
}

// Para usar al inicio de un handler: si no hay sesión responde el error y devuelve null.
async function exigirSesion(req, res, permisos = []) {
  try {
    return await module.exports.sesionPanel(req, permisos); // (por module.exports para poder simularla en las pruebas)
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(e.status || 500).json({ error: e.message });
    return null;
  }
}

module.exports = { sesionPanel, exigirSesion, SesionError, credsDe };
