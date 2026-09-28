// Vercel serverless function: registro de clientes y recuperación de
// contraseña con correos de Mi Fiestashop (no de Supabase).
//
// Antes el sitio llamaba directo a /auth/v1/signup y /auth/v1/recover de
// Supabase Auth, que mandan su propio correo (remitente
// noreply@mail.app.supabase.io, plantilla en inglés). Ahora el enlace se
// genera aquí con la API de administración de Supabase
// (admin/generate_link, que NO envía nada por sí sola) y el correo sale de
// la cuenta SMTP de la tienda con la plantilla propia (lib/correo.js). El
// enlace apunta a nuestro propio dominio (?confirmar= / ?recuperar=) y el
// navegador lo canjea con /auth/v1/verify (ver index.html).
//
// POST { accion: 'registro', nombre, email, telefono, password }
//   -> { ok: true, userId }
//   -> 409 { code: 'cuenta_existente', origen: 'web' | 'prestashop' } si el
//      correo ya tiene cuenta (web o de la tienda anterior en PrestaShop):
//      el sitio le ofrece restablecer la contraseña.
// POST { accion: 'recuperar', email }
//   -> { ok: true } (siempre, exista o no la cuenta, para no revelar qué
//      correos están registrados). Si el correo es de un cliente de
//      PrestaShop sin acceso web todavía, se le crea el acceso y recibe el
//      mismo correo para poner su contraseña.
//
// Requiere SUPABASE_SERVICE_ROLE_KEY y SMTP_* en Vercel.
const { sendTemplate, smtpConfigured, ALLOWED_LINK_HOSTS } = require('../lib/correo.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_HOST = 'www.mifiestashop.com';

// El enlace del correo va al mismo dominio desde el que se registró el
// cliente, pero solo si es uno de los nuestros (el header Host lo manda el
// cliente y no se puede confiar en él tal cual).
function siteOrigin(req) {
  const host = String(req.headers?.host || '').toLowerCase().split(':')[0];
  return `https://${ALLOWED_LINK_HOSTS.includes(host) ? host : DEFAULT_HOST}`;
}

async function generateLink(serviceRoleKey, payload) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  // La API REST devuelve los datos del enlace a nivel raíz; supabase-js los
  // reacomoda en "properties" — se aceptan ambas formas.
  const hashedToken = data.hashed_token || data.properties?.hashed_token || null;
  const userId = data.id || data.user?.id || null;
  return { ok: r.ok, status: r.status, data, hashedToken, userId };
}

// Cliente de la tienda anterior (PrestaShop) con este correo, si existe.
// ilike + comparación exacta en JS: el correo puede venir con mayúsculas en
// ps_clientes, y "_" es comodín en ilike.
async function findPrestashopCustomer(serviceRoleKey, email) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ps_clientes?select=id,name,phone,email&email=ilike.${encodeURIComponent(email)}&limit=5`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return (Array.isArray(rows) ? rows : []).find(c => String(c.email || '').toLowerCase() === email) || null;
}

// Crea el acceso a la tienda nueva para un cliente de PrestaShop (con una
// contraseña aleatoria que nadie conoce): el cliente pone la suya con el
// enlace de recuperación.
async function createWebAccessForPrestashopCustomer(serviceRoleKey, email, ps) {
  const crypto = require('node:crypto');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, email_confirm: true, password: crypto.randomBytes(24).toString('base64url'),
      user_metadata: { full_name: ps.name || '', phone: ps.phone || '', ps_customer_id: ps.id }
    })
  });
  return r.ok;
}

// Cuenta web con este correo (Supabase Auth), si existe.
async function findAuthUserByEmail(serviceRoleKey, email) {
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    const users = Array.isArray(data.users) ? data.users : [];
    const found = users.find(u => String(u.email || '').toLowerCase() === email);
    if (found) return found;
    if (users.length < 1000) return null;
  }
  return null;
}

// Cada enlace de recuperación nuevo invalida el anterior: si se pide dos
// veces seguidas (doble clic), el primer correo llega con un enlace que ya
// no sirve ("ya expiró o ya se usó"). Durante este tiempo después de un
// envío, no se genera otro enlace.
const RECOVERY_COOLDOWN_MS = 60 * 1000;

async function deleteUser(serviceRoleKey, userId) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey || !smtpConfigured()) {
    res.status(500).json({ error: 'El registro no está disponible en este momento. Intenta más tarde o escríbenos por WhatsApp.' });
    return;
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) {
    res.status(400).json({ error: 'Ingresa un correo válido.' });
    return;
  }
  const origin = siteOrigin(req);

  if (body.accion === 'registro') {
    const nombre = String(body.nombre || '').trim().slice(0, 120);
    const telefono = String(body.telefono || '').trim().slice(0, 40);
    const password = String(body.password || '');
    if (!nombre) { res.status(400).json({ error: 'Ingresa tu nombre completo.' }); return; }
    if (password.length < 6) { res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' }); return; }

    // Si ya fue cliente de la tienda anterior (PrestaShop), no se crea una
    // cuenta nueva desde cero: se le pide restablecer la contraseña, que le
    // crea el acceso con sus mismos datos (ver accion 'recuperar').
    if (await findPrestashopCustomer(serviceRoleKey, email)) {
      res.status(409).json({ code: 'cuenta_existente', origen: 'prestashop', error: 'Ya eres cliente de Mi Fiestashop con este correo. Para entrar, restablece tu contraseña.' });
      return;
    }

    const link = await generateLink(serviceRoleKey, {
      type: 'signup', email, password,
      data: { full_name: nombre, phone: telefono },
      redirect_to: origin
    });
    if (!link.ok || !link.hashedToken) {
      const msg = String(link.data.msg || link.data.error_description || link.data.message || '');
      if (link.status === 422 || /already|registered|exists/i.test(msg)) {
        res.status(409).json({ code: 'cuenta_existente', origen: 'web', error: 'Ya existe una cuenta con este correo. Inicia sesión o restablece tu contraseña.' });
      } else {
        res.status(502).json({ error: 'No se pudo crear la cuenta. Intenta de nuevo.', detail: msg.slice(0, 200) });
      }
      return;
    }

    try {
      await sendTemplate(email, 'confirmacion', { nombre, confirmUrl: `${origin}/?confirmar=${encodeURIComponent(link.hashedToken)}` });
    } catch (err) {
      // Sin correo la cuenta quedaría creada pero imposible de confirmar;
      // se borra para que el cliente pueda volver a intentarlo.
      if (link.userId) await deleteUser(serviceRoleKey, link.userId);
      res.status(502).json({ error: 'No pudimos enviarte el correo de confirmación. Intenta de nuevo en unos minutos.' });
      return;
    }
    res.status(200).json({ ok: true, userId: link.userId });
    return;
  }

  if (body.accion === 'recuperar') {
    const existing = await findAuthUserByEmail(serviceRoleKey, email);
    const sentAt = existing?.recovery_sent_at ? new Date(existing.recovery_sent_at).getTime() : 0;
    if (sentAt && Date.now() - sentAt < RECOVERY_COOLDOWN_MS) {
      res.status(200).json({ ok: true, yaEnviado: true });
      return;
    }
    let link = await generateLink(serviceRoleKey, { type: 'recovery', email, redirect_to: origin });
    // Sin cuenta web pero sí cliente de la tienda anterior: se le crea el
    // acceso y se manda el mismo correo para que ponga su contraseña.
    if (!(link.ok && link.hashedToken)) {
      const ps = await findPrestashopCustomer(serviceRoleKey, email);
      if (ps && await createWebAccessForPrestashopCustomer(serviceRoleKey, email, ps)) {
        link = await generateLink(serviceRoleKey, { type: 'recovery', email, redirect_to: origin });
      }
    }
    if (link.ok && link.hashedToken) {
      const nombre = link.data.user_metadata?.full_name || link.data.user?.user_metadata?.full_name || '';
      try {
        await sendTemplate(email, 'recuperacion', { nombre, resetUrl: `${origin}/?recuperar=${encodeURIComponent(link.hashedToken)}` });
      } catch (err) {
        res.status(502).json({ error: 'No pudimos enviar el correo. Intenta de nuevo en unos minutos.' });
        return;
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Acción no reconocida.' });
};
