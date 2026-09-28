// Vercel serverless function: al regresar de Mercado Pago, la página de
// "gracias por tu compra" pregunta aquí cómo quedó el pago. Se consulta el
// pago directo en Mercado Pago (nunca se confía en lo que dice la URL) y se
// actualiza el pedido igual que el webhook — por si la notificación de
// Mercado Pago tarda o no llega.
//
// POST { folio, paymentId } -> { folio, estado, mpStatus, total }
//   estado: "Pago aceptado" | "Pendiente de pago" | "Error en el pago" | ...
const { aplicarPago } = require('../lib/mp-pago.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  const folio = String(body.folio || '').trim();
  const paymentId = String(body.paymentId || '').trim();
  if (!/^[A-Z]+-\d+$/.test(folio) || !/^\d{1,20}$/.test(paymentId)) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const accessToken = process.env.MP_ACCESS_TOKEN;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!accessToken || !serviceRoleKey) { res.status(500).json({ error: 'Mercado Pago no está configurado' }); return; }

  try {
    const r = await aplicarPago({ accessToken, serviceRoleKey, paymentId, folioEsperado: folio });
    if (!r) { res.status(404).json({ error: 'No encontramos ese pago para este pedido.' }); return; }
    res.status(200).json(r);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo consultar Mercado Pago.' });
  }
};
