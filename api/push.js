// Suscripciones a notificaciones push del back office.
//   GET  /api/push                          -> { publicKey }  (llave VAPID pública)
//   POST { p_admin_password, p_staff_email, p_staff_pin, accion: "suscribir",  subscription, dispositivo? }
//   POST { ...sesión, accion: "cancelar", endpoint }
//   POST { ...sesión, accion: "probar" }     -> manda una notificación de prueba
// Solo quien tiene sesión de admin/personal puede suscribirse.
const { pushConfigurado, enviarPushAdmins } = require('../lib/push.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function checkSession(b) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: b.p_admin_password ?? null, p_staff_email: b.p_staff_email ?? null, p_staff_pin: b.p_staff_pin ?? null })
  });
  return r.ok && !!(await r.json());
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    if (!process.env.VAPID_PUBLIC_KEY) { res.status(200).json({ publicKey: null, error: 'Push sin configurar (faltan las llaves VAPID en Vercel).' }); return; }
    res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  if (!(await checkSession(body).catch(() => false))) { res.status(401).json({ error: 'unauthorized' }); return; }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  try {
    if (body.accion === 'suscribir') {
      const s = body.subscription || {};
      const endpoint = String(s.endpoint || '');
      const p256dh = s.keys && s.keys.p256dh, auth = s.keys && s.keys.auth;
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) { res.status(400).json({ error: 'Suscripción inválida.' }); return; }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ endpoint, p256dh: String(p256dh), auth: String(auth), dispositivo: String(body.dispositivo || '').slice(0, 200) })
      });
      if (!r.ok) { res.status(502).json({ error: `No se pudo guardar la suscripción (${r.status}). ¿Existe la tabla push_subscriptions?`, detail: (await r.text()).slice(0, 200) }); return; }
      res.status(200).json({ ok: true });
      return;
    }
    if (body.accion === 'cancelar') {
      const endpoint = String(body.endpoint || '');
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE', headers: h });
      res.status(200).json({ ok: true });
      return;
    }
    if (body.accion === 'probar') {
      if (!pushConfigurado()) { res.status(500).json({ error: 'Push sin configurar (faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en Vercel).' }); return; }
      const out = await enviarPushAdmins({ title: 'Notificación de prueba', body: 'Así te llegarán los avisos de Mi Fiestashop, incluso con la app cerrada.', url: '/', tag: 'prueba' });
      res.status(200).json(out);
      return;
    }
    res.status(400).json({ error: 'Acción no válida.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
