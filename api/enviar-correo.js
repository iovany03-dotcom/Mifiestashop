// Vercel serverless function: envía correos transaccionales reales (confirmación
// de pedido, suscripción al newsletter) usando la cuenta SMTP de Hostinger.
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

const nodemailer = require('nodemailer');

const TEMPLATES = {
  pedido: ({ nombre, pedidoId, total, items }) => ({
    subject: `Confirmación de tu pedido #${pedidoId} — Mi Fiestashop`,
    html: `
      <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto;">
        <h2 style="color:#d3007b;">¡Gracias por tu compra, ${nombre || 'cliente'}!</h2>
        <p>Recibimos tu pedido <b>#${pedidoId}</b> por un total de <b>$${Number(total || 0).toFixed(2)} MXN</b>.</p>
        ${Array.isArray(items) && items.length ? `
          <ul style="padding-left:18px;">
            ${items.map(it => `<li>${it.qty || 1} x ${it.name || 'Producto'} — $${Number(it.price || 0).toFixed(2)}</li>`).join('')}
          </ul>` : ''}
        <p>Te avisaremos en cuanto tu pedido esté en camino. Si tienes dudas, escríbenos por WhatsApp: 561 262 2146.</p>
        <p style="color:#8b7d97; font-size:12px;">Mi Fiestashop — Artículos para fiesta y batucada al mayoreo.</p>
      </div>`
  }),
  suscripcion: ({ email }) => ({
    subject: '¡Bienvenido a las novedades de Mi Fiestashop! 🎉',
    html: `
      <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto;">
        <h2 style="color:#d3007b;">¡Listo, ${email}!</h2>
        <p>Ya estás suscrito para recibir promociones, descuentos de mayoreo y novedades de Mi Fiestashop.</p>
        <p style="color:#8b7d97; font-size:12px;">Si no te suscribiste tú, puedes ignorar este correo.</p>
      </div>`
  }),
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
