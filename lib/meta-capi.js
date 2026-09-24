// Meta Conversions API (eventos desde el servidor). Complementa al píxel del
// navegador: los bloqueadores de anuncios y la privacidad de iOS tiran parte
// de los eventos del navegador, y una compra con Mercado Pago solo se
// reportaba si el cliente regresaba al sitio después de pagar.
//
// Requiere la variable de entorno META_CAPI_TOKEN (token de la API de
// Conversiones del dataset, generado en Events Manager). Sin ella no hace
// nada y no rompe nada. META_PIXEL_ID es opcional (por defecto el del sitio).
//
// Deduplicación: el navegador manda el mismo eventID (el folio del pedido)
// en su fbq('track', ...) — Meta descarta el duplicado y cuenta uno solo.
const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '937979512914198';
const API_VERSION = 'v21.0';

// Meta pide correo/teléfono/nombre normalizados y con SHA-256.
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashedEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return v ? sha256(v) : undefined;
}

// Solo dígitos, con lada de México (52) si vienen 10 dígitos.
function hashedPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '52' + d;
  return d ? sha256(d) : undefined;
}

function hashedName(name) {
  const v = String(name || '').trim().toLowerCase();
  return v ? sha256(v) : undefined;
}

async function sendMetaEvent({ eventName, eventId, eventSourceUrl, value, currency = 'MXN', contents, customer, testEventCode }) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { skipped: true, reason: 'META_CAPI_TOKEN no configurado' };

  const parts = String((customer && customer.name) || '').trim().split(/\s+/).filter(Boolean);
  const userData = {
    em: hashedEmail(customer && customer.email),
    ph: hashedPhone(customer && customer.phone),
    fn: hashedName(parts[0]),
    ln: hashedName(parts.length > 1 ? parts[parts.length - 1] : ''),
    country: sha256('mx'),
  };
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  const customData = { value, currency };
  if (Array.isArray(contents) && contents.length > 0) {
    customData.content_type = 'product';
    customData.content_ids = contents.map(c => String(c.id));
    customData.contents = contents.map(c => ({ id: String(c.id), quantity: c.quantity }));
    customData.num_items = contents.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  }

  const body = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: String(eventId),
      action_source: 'website',
      event_source_url: eventSourceUrl,
      user_data: userData,
      custom_data: customData,
    }],
  };

  if (testEventCode) body.test_event_code = testEventCode;

  const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text().catch(() => '');
  return { ok: r.ok, status: r.status, detail: r.ok ? undefined : text.slice(0, 300) };
}

module.exports = { sendMetaEvent, hashedEmail, hashedPhone, hashedName };
