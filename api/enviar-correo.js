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
//   - "recuperacion" y "confirmacion" no se envían desde aquí: llevan un
//     enlace de Supabase Auth que solo api/cuenta-cliente.js puede generar
//     (con la llave de servicio); aquí solo sirven para la vista previa.
//
// Las plantillas y el envío viven en lib/correo.js.

const { TEMPLATES, sendTemplate, smtpConfigured } = require('../lib/correo.js');

// Tipos que este endpoint puede enviar de verdad por POST. "recuperacion" y
// "confirmacion" se quedan fuera a propósito: solo se sirven como vista
// previa (GET); el envío real lo hace api/cuenta-cliente.js.
const SENDABLE_TYPES = new Set(['bienvenida', 'pedido', 'envio', 'suscripcion']);

// Datos de ejemplo usados solo para la vista previa en el Backoffice — no
// se envía ningún correo real al generar una vista previa.
const PREVIEW_SAMPLE_DATA = {
  bienvenida: { nombre: 'Ana García' },
  recuperacion: { nombre: 'Ana García', resetUrl: 'https://mifiestashop.com/?recuperar=ejemplo' },
  confirmacion: { nombre: 'Ana García', confirmUrl: 'https://mifiestashop.com/?confirmar=ejemplo' },
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

  if (!smtpConfigured()) {
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
    await sendTemplate(to, tipo, datos);
    res.status(200).json({ sent: true });
  } catch (err) {
    res.status(502).json({ error: 'Fallo al enviar el correo', detail: String(err) });
  }
};
