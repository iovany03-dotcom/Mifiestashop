// Vercel serverless function: check-in en HR PRO obligatorio para usar el back de Mi Fiesta Shop.
// Quien trabaja en HR (personal con sesión de correo + PIN/contraseña) y no ha registrado hoy su
// ENTRADA en HR solo ve la pantalla "Registra tu entrada" del panel (index.html → hrCheckinRevisar).
// La entrada se guarda SIEMPRE en HR (/api/integrations/checkin de HR, con la geocerca de HR).
// El administrador (sesión con contraseña de admin) y los exentos que decide HR no se bloquean.
// Si HR no responde, no se bloquea a nadie.
//
//   POST { accion: 'estado', creds }                         → { required, checkedIn, employeeName }
//   POST { accion: 'checkin', creds, latitude, longitude }   → registra la entrada en HR
//
// Llave de HR: variable HR_CHECKIN_KEY o tabla privada hr_bridge_config (solo service_role).
const sesion = require('../lib/sesion-panel.js');
const { credsDe } = sesion;

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const HR_DEFAULT_URL = 'https://asistencia-y62m.vercel.app';

async function configHR() {
  let key = process.env.HR_CHECKIN_KEY || '';
  let url = process.env.HR_BASE_URL || '';
  if (!key || !url) {
    const sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (sk) {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/hr_bridge_config?id=eq.1&select=hr_base_url,hr_checkin_key`, {
          headers: { apikey: sk, Authorization: `Bearer ${sk}` }
        });
        const rows = r.ok ? await r.json() : [];
        key = key || String(rows[0]?.hr_checkin_key || '');
        url = url || String(rows[0]?.hr_base_url || '');
      } catch (e) { /* sin config: no se bloquea */ }
    }
  }
  return { key, url: (url || HR_DEFAULT_URL).replace(/\/$/, '') };
}

const NO_BLOQUEAR = (reason) => ({ required: false, checkedIn: false, reason });

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  let fila;
  try { fila = await module.exports.sesionPanel(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  // El dueño entra con la contraseña de administrador: nunca se le pide check-in.
  const creds = credsDe(req) || {};
  const email = String(creds.p_staff_email || '').trim().toLowerCase();
  if (fila.es_admin && !email) return res.status(200).json(NO_BLOQUEAR('admin'));
  if (!email) return res.status(200).json(NO_BLOQUEAR('sin_correo'));

  const { key, url } = await configHR();
  if (!key) return res.status(200).json(NO_BLOQUEAR('no_configurado'));

  try {
    if (body.accion === 'checkin') {
      const r = await fetch(`${url}/api/integrations/checkin`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, latitude: Number(body.latitude), longitude: Number(body.longitude) })
      });
      const d = await r.json().catch(() => ({}));
      return res.status(r.ok ? 200 : (r.status >= 400 && r.status < 500 && r.status !== 401 ? 400 : 502)).json(d);
    }
    const r = await fetch(`${url}/api/integrations/checkin?${new URLSearchParams({ email })}`, {
      headers: { 'x-api-key': key }, signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return res.status(200).json(NO_BLOQUEAR('hr_no_disponible'));
    return res.status(200).json(await r.json());
  } catch (e) {
    // HR caído: nunca dejar a alguien sin poder trabajar.
    return res.status(200).json(NO_BLOQUEAR('hr_no_disponible'));
  }
};

module.exports.sesionPanel = (req) => sesion.sesionPanel(req); // (para simularla en las pruebas)
