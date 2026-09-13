// Vercel serverless function: envía correos transaccionales reales (registro
// de cuenta, recuperación de contraseña, confirmación de pedido, envío en
// camino, suscripción al newsletter) usando la cuenta SMTP de Hostinger.
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

const nodemailer = require('nodemailer');

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
      <h2 style="color:#d3007b;">¡Hola, ${nombre || 'nuevo cliente'}!</h2>
      <p>Gracias por crear tu cuenta en <b>Mi Fiestashop</b>. Ya puedes iniciar sesión para ver el estado de tus pedidos, guardar tus datos de envío y repetir tus compras favoritas en un clic.</p>
      <p style="text-align:center; margin:26px 0;">
        <a href="https://mifiestashop.com" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Ir a mi cuenta</a>
      </p>
      <p>Si tú no creaste esta cuenta, puedes ignorar este correo.</p>
    `)
  }),
  recuperacion: ({ nombre, resetUrl } = {}) => ({
    subject: 'Recupera el acceso a tu cuenta — Mi Fiestashop',
    html: layout(`
      <h2 style="color:#d3007b;">Recupera tu contraseña</h2>
      <p>Hola${nombre ? ', ' + nombre : ''}. Recibimos una solicitud para restablecer la contraseña de tu cuenta en Mi Fiestashop.</p>
      <p style="text-align:center; margin:26px 0;">
        <a href="${resetUrl || '#'}" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Crear nueva contraseña</a>
      </p>
      <p>Si tú no solicitaste este cambio, puedes ignorar este correo: tu contraseña actual seguirá funcionando.</p>
      <p style="font-size:12px; color:#8b7d97;">Este enlace expira en 1 hora por seguridad.</p>
    `)
  }),
  pedido: ({ nombre, pedidoId, total, items } = {}) => ({
    subject: `Confirmación de tu pedido #${pedidoId} — Mi Fiestashop`,
    html: layout(`
      <h2 style="color:#d3007b;">¡Gracias por tu compra, ${nombre || 'cliente'}!</h2>
      <p>Recibimos tu pedido <b>#${pedidoId}</b> por un total de <b>$${Number(total || 0).toFixed(2)} MXN</b>.</p>
      ${Array.isArray(items) && items.length ? `
        <ul style="padding-left:18px;">
          ${items.map(it => `<li>${it.qty || 1} x ${it.name || 'Producto'} — $${Number(it.price || 0).toFixed(2)}</li>`).join('')}
        </ul>` : ''}
      <p>Te avisaremos por este mismo correo en cuanto tu pedido salga hacia tu domicilio.</p>
    `)
  }),
  envio: ({ nombre, pedidoId, carrier, trackingNumber, trackingUrl } = {}) => ({
    subject: `¡Tu pedido #${pedidoId} va en camino! 🚚 — Mi Fiestashop`,
    html: layout(`
      <h2 style="color:#d3007b;">¡Tu pedido va en camino, ${nombre || 'cliente'}!</h2>
      <p>Tu pedido <b>#${pedidoId}</b> fue entregado a la paquetería <b>${carrier || 'nuestro repartidor'}</b> y está en camino a tu domicilio.</p>
      ${trackingNumber ? `<p><b>Número de guía:</b> ${trackingNumber}</p>` : ''}
      ${trackingUrl ? `
        <p style="text-align:center; margin:26px 0;">
          <a href="${trackingUrl}" style="background:#d3007b; color:#fff; padding:12px 26px; border-radius:24px; text-decoration:none; font-weight:700; display:inline-block;">Rastrear mi pedido</a>
        </p>` : ''}
      <p>Gracias por tu compra, ¡esperamos que disfrutes tu fiesta!</p>
    `)
  }),
  suscripcion: ({ email } = {}) => ({
    subject: '¡Bienvenido a las novedades de Mi Fiestashop! 🎉',
    html: layout(`
      <h2 style="color:#d3007b;">¡Listo, ${email || ''}!</h2>
      <p>Ya estás suscrito para recibir promociones, descuentos de mayoreo y novedades de Mi Fiestashop.</p>
      <p style="color:#8b7d97; font-size:12px;">Si no te suscribiste tú, puedes ignorar este correo.</p>
    `)
  }),
};

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
  if (!to || !TEMPLATES[tipo]) {
    res.status(400).json({ error: 'Falta "to" o "tipo" de correo no reconocido' });
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
