// Notificaciones push (Web Push + VAPID) para el back office: llegan aunque la
// app esté cerrada. Las suscripciones viven en la tabla push_subscriptions
// (ver docs/push-notificaciones.md); solo la llave de servicio puede leerla.
//
// Env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (opcional,
// "mailto:..."), SUPABASE_SERVICE_ROLE_KEY.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

function pushConfigurado() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Manda el aviso a todos los dispositivos suscritos. Nunca lanza: un fallo del
// push no debe romper el pedido ni el pago que lo originó.
async function enviarPushAdmins({ title, body, url, tag }) {
  if (!pushConfigurado()) return { enviados: 0, motivo: 'sin configurar' };
  try {
    const webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:contacto@mifiestashop.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const h = { apikey: key, Authorization: `Bearer ${key}` };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth&limit=500`, { headers: h });
    if (!r.ok) return { enviados: 0, motivo: `supabase ${r.status}` };
    const subs = await r.json();
    const payload = JSON.stringify({ title, body, url: url || '/', tag: tag || undefined });
    let enviados = 0;
    await Promise.all((Array.isArray(subs) ? subs : []).map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        enviados++;
      } catch (e) {
        // 404/410: el dispositivo ya no existe (desinstaló la app o revocó el permiso).
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE', headers: h }).catch(() => {});
        }
      }
    }));
    return { enviados };
  } catch (e) {
    console.error('push:', e.message);
    return { enviados: 0, motivo: e.message };
  }
}

module.exports = { pushConfigurado, enviarPushAdmins };
