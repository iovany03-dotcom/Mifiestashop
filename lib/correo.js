// Plantillas y envío de correos transaccionales de Mi Fiestashop, con la
// cuenta SMTP propia (Hostinger) — compartido por api/enviar-correo.js y
// api/cuenta-cliente.js (confirmación de cuenta y recuperación de
// contraseña, que antes mandaba Supabase Auth con su propio remitente
// noreply@mail.app.supabase.io y su plantilla en inglés).
//
// Variables de entorno (Vercel): SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.

const nodemailer = require('nodemailer');

// Dominios propios a los que se permite enlazar desde un correo. Cualquier
// otro valor recibido en resetUrl/trackingUrl se descarta.
const ALLOWED_LINK_HOSTS = ['mifiestashop.com', 'www.mifiestashop.com', 'mifiestashop.vercel.app'];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Devuelve la URL tal cual solo si es https y apunta a uno de nuestros
// propios dominios; de lo contrario null (el enlace simplemente no se
// incluye en el correo).
function safeOwnUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'https:' && ALLOWED_LINK_HOSTS.includes(u.hostname)) return u.toString();
  } catch (e) { /* URL inválida */ }
  return null;
}

function layout(innerHtml) {
  return `
    <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto; color:#2e1065;">
      <div style="text-align:center; padding:18px 0;">
        <span style="font-size:22px; font-weight:800; color:#d3007b;">🎉 Mi Fiestashop</span>
      </div>
      ${innerHtml}
      <p style="color:#8b7d97; font-size:12px; text-align:center; margin-top:28px; border-top:1px solid #f0e6ef; padding-top:14px;">
        Mi Fiestashop — Artículos para fiesta, globos, decoración y pirotecnia fría al mayoreo y menudeo.<br>
        ¿Dudas? Escríbenos por WhatsApp al <a href="https://wa.me/525612622146" style="color:#d3007b;">561 262 2146</a>.
      </p>
    </div>`;
}

const TEMPLATES = {
  bienvenida: ({ nombre } = {}) => ({
    subject: '¡Bienvenido a Mi Fiestashop! 🎉 Tu cuenta ya está lista',
    html: layout(`
      <h2 style="color:#d3007b;">¡Hola, ${escapeHtml(nombre || 'nuevo cliente')}!</h2>
      <p>Gracias por crear tu cuenta en <b>Mi Fiestashop</b>. Ya puedes iniciar sesión para ver el estado de tus pedidos, guardar tus datos de envío y repetir tus compras favoritas en un clic.</p>
      <p style="text-align:center; margin:26px 0;">
        <a href="https://mifiestashop.com" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Ir a mi cuenta</a>
      </p>
      <p>Si tú no creaste esta cuenta, puedes ignorar este correo.</p>
    `)
  }),
  // Confirmación de cuenta nueva: se envía desde api/cuenta-cliente.js con
  // el enlace que genera Supabase Auth (admin/generate_link), para que el
  // correo llegue de Mi Fiestashop y no de Supabase.
  confirmacion: ({ nombre, confirmUrl } = {}) => ({
    subject: 'Confirma tu correo para activar tu cuenta — Mi Fiestashop',
    html: layout(`
      <h2 style="color:#d3007b;">¡Hola, ${escapeHtml(nombre || 'nuevo cliente')}!</h2>
      <p>Gracias por crear tu cuenta en <b>Mi Fiestashop</b>. Para activarla, confirma tu correo con el botón de abajo.</p>
      <p style="text-align:center; margin:26px 0;">
        <a href="${safeOwnUrl(confirmUrl) || '#'}" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Confirmar mi correo</a>
      </p>
      <p>Con tu cuenta podrás ver el estado de tus pedidos, guardar tus datos de envío y repetir tus compras favoritas en un clic.</p>
      <p style="font-size:12px; color:#8b7d97;">Si tú no creaste esta cuenta, puedes ignorar este correo.</p>
    `)
  }),
  // Recuperación de contraseña: la envía api/cuenta-cliente.js con el enlace
  // de Supabase Auth (admin/generate_link). No se puede enviar desde
  // api/enviar-correo.js (ver SENDABLE_TYPES ahí).
  recuperacion: ({ nombre, resetUrl } = {}) => ({
    subject: 'Recupera el acceso a tu cuenta — Mi Fiestashop',
    html: layout(`
      <h2 style="color:#d3007b;">Recupera tu contraseña</h2>
      <p>Hola${nombre ? ', ' + escapeHtml(nombre) : ''}. Recibimos una solicitud para restablecer la contraseña de tu cuenta en Mi Fiestashop.</p>
      <p style="text-align:center; margin:26px 0;">
        <a href="${safeOwnUrl(resetUrl) || '#'}" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Crear nueva contraseña</a>
      </p>
      <p>Si tú no solicitaste este cambio, puedes ignorar este correo: tu contraseña actual seguirá funcionando.</p>
      <p style="font-size:12px; color:#8b7d97;">Este enlace expira en 1 hora por seguridad.</p>
    `)
  }),
  pedido: ({ nombre, pedidoId, total, items } = {}) => ({
    subject: `Confirmación de tu pedido #${escapeHtml(pedidoId)} — Mi Fiestashop`,
    html: layout(`
      <h2 style="color:#d3007b;">¡Gracias por tu compra, ${escapeHtml(nombre || 'cliente')}!</h2>
      <p>Recibimos tu pedido <b>#${escapeHtml(pedidoId)}</b> por un total de <b>$${Number(total || 0).toFixed(2)} MXN</b>.</p>
      ${Array.isArray(items) && items.length ? `
        <ul style="padding-left:18px;">
          ${items.map(it => `<li>${Number(it.qty || 1)} x ${escapeHtml(it.name || 'Producto')} — $${Number(it.price || 0).toFixed(2)}</li>`).join('')}
        </ul>` : ''}
      <p>Te avisaremos por este mismo correo en cuanto tu pedido salga hacia tu domicilio.</p>
    `)
  }),
  envio: ({ nombre, pedidoId, carrier, trackingNumber, trackingUrl } = {}) => ({
    subject: `¡Tu pedido #${escapeHtml(pedidoId)} va en camino! 🚚 — Mi Fiestashop`,
    html: layout(`
      <h2 style="color:#d3007b;">¡Tu pedido va en camino, ${escapeHtml(nombre || 'cliente')}!</h2>
      <p>Tu pedido <b>#${escapeHtml(pedidoId)}</b> fue entregado a la paquetería <b>${escapeHtml(carrier || 'nuestro repartidor')}</b> y está en camino a tu domicilio.</p>
      ${trackingNumber ? `<p><b>Número de guía:</b> ${escapeHtml(trackingNumber)}</p>` : ''}
      ${safeOwnUrl(trackingUrl) ? `
        <p style="text-align:center; margin:26px 0;">
          <a href="${safeOwnUrl(trackingUrl)}" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Rastrear mi pedido</a>
        </p>` : ''}
      <p>Gracias por tu compra, ¡esperamos que disfrutes tu fiesta!</p>
    `)
  }),
  suscripcion: ({ email } = {}) => ({
    subject: '¡Bienvenido a las novedades de Mi Fiestashop! 🎉',
    html: layout(`
      <h2 style="color:#d3007b;">¡Listo, ${escapeHtml(email || '')}!</h2>
      <p>Ya estás suscrito para recibir promociones, descuentos de mayoreo y novedades de Mi Fiestashop.</p>
      <p style="color:#8b7d97; font-size:12px;">Si no te suscribiste tú, puedes ignorar este correo.</p>
    `)
  }),
};

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Envía la plantilla `tipo` a `to`. Lanza error si el SMTP no está
// configurado o si el envío falla — quien llama decide cómo responder.
async function sendTemplate(to, tipo, datos) {
  if (!smtpConfigured()) throw new Error('SMTP no configurado en Vercel');
  const port = parseInt(process.env.SMTP_PORT, 10);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const { subject, html } = TEMPLATES[tipo](datos || {});
  await transporter.sendMail({ from: `"Mi Fiestashop" <${process.env.SMTP_USER}>`, to, subject, html });
}

module.exports = { TEMPLATES, ALLOWED_LINK_HOSTS, escapeHtml, safeOwnUrl, layout, smtpConfigured, sendTemplate };
