// Vercel serverless function: envía correos transaccionales reales (registro
// de cuenta, confirmación de pedido, envío en camino, suscripción al
// newsletter) usando la cuenta SMTP de Hostinger.
//
// Requiere estas variables de entorno en Vercel (Project Settings > Environment
// Variables) — el remitente NUNCA se guarda en el código ni en el repo:
//   SMTP_HOST   ej. smtp.hostinger.com
//   SMTP_PORT   ej. 465
//   SMTP_USER   ej. cliente@mifiestashop.com
//   SMTP_PASS   la contraseña del correo
//
// Si las variables no están configuradas, responde 200 con fallback:true en
// vez de fallar, para no romper el checkout ni el formulario de suscripción
// mientras se configura el correo (mismo patrón que api/productos.js con
// PS_API_KEY).
//
// GET /api/enviar-correo?preview=<tipo>  -> { subject, html } con datos de
// ejemplo, para que el Backoffice pueda mostrar una vista previa real de la
// plantilla sin necesidad de tener el SMTP configurado ni enviar nada.
// POST /api/enviar-correo { to, tipo, datos } -> envía el correo real.
//
// Este endpoint no requiere sesión (lo dispara el checkout público sin
// login), así que cualquiera podría llamarlo directamente con un "to"
// arbitrario. Para que eso no se pueda usar como relay de spam/phishing con
// el dominio real de la tienda:
//   - Todo texto que viene del llamador (nombre, paquetería, etc.) se
//     escapa antes de insertarse en el HTML del correo.
//   - Los únicos enlaces que puede llevar un correo (recuperar contraseña,
//     rastreo de envío) se validan contra un dominio propio permitido; si no
//     coinciden, se descarta el enlace en vez de usarlo tal cual.
//   - El tipo "recuperacion" no se envía desde aquí: el restablecimiento de
//     contraseña real lo maneja Supabase Auth con su propia plantilla; este
//     tipo solo existe para la vista previa en el Backoffice.

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
  // Solo se usa para la vista previa en el Backoffice (ver "sendable" más
  // abajo) — el restablecimiento real de contraseña lo envía Supabase Auth.
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

// Tipos que este endpoint puede enviar de verdad por POST. "recuperacion"
// se queda fuera a propósito: solo se sirve como vista previa (GET), el
// envío real de recuperación de contraseña lo hace Supabase Auth.
const SENDABLE_TYPES = new Set(['bienvenida', 'pedido', 'envio', 'suscripcion']);

// Datos de ejemplo usados solo para la vista previa en el Backoffice — no
// se envía ningún correo real al generar una vista previa.
const PREVIEW_SAMPLE_DATA = {
  bienvenida: { nombre: 'Ana García' },
  recuperacion: { nombre: 'Ana García', resetUrl: 'https://mifiestashop.com/recuperar-contrasena?token=ejemplo' },
  pedido: { nombre: 'Ana García', pedidoId: 'WEB-482913', total: 1850, items: [
    { qty: 2, name: 'Globo Metálico 40" Dorado', price: 45 },
    { qty: 1, name: 'Paquete Globos Latex Pastel (50 pzs)', price: 85 }
  ] },
  envio: { nombre: 'Ana García', pedidoId: 'WEB-482913', carrier: 'Estafeta', trackingNumber: 'EST123456789MX', trackingUrl: 'https://mifiestashop.com/rastreo?guia=EST123456789MX' },
  suscripcion: { email: 'ana@ejemplo.com' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    const tipo = req.query.preview;
    if (!tipo || !TEMPLATES[tipo]) {
      res.status(400).json({ error: 'Falta "preview" o tipo de plantilla no reconocido' });
      return;
    }
    const { subject, html } = TEMPLATES[tipo](PREVIEW_SAMPLE_DATA[tipo] || {});
    res.status(200).json({ subject, html });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const { host, port, user, pass } = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  };

  if (!host || !port || !user || !pass) {
    res.status(200).json({ fallback: true, message: 'SMTP no configurado en Vercel todavía.' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const { to, tipo, datos } = body;
  if (!to || typeof to !== 'string' || !EMAIL_RE.test(to)) {
    res.status(400).json({ error: 'Falta "to" o no es un correo válido' });
    return;
  }
  if (!tipo || !SENDABLE_TYPES.has(tipo)) {
    res.status(400).json({ error: 'Tipo de correo no permitido para envío' });
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(port, 10),
      secure: parseInt(port, 10) === 465,
      auth: { user, pass },
    });

    const { subject, html } = TEMPLATES[tipo](datos || {});
    await transporter.sendMail({
      from: `"Mi Fiestashop" <${user}>`,
      to,
      subject,
      html,
    });

    res.status(200).json({ sent: true });
  } catch (err) {
    res.status(502).json({ error: 'Fallo al enviar el correo', detail: String(err) });
  }
};
