// Vercel serverless function: recibe las notificaciones (webhooks) que manda
// Mercado Pago cuando cambia el estado de un pago, y actualiza el pedido
// correspondiente en pedidos_online (ver lib/mp-pago.js para los estados).
//
// Configurado como notification_url al crear la preferencia en
// api/mp-crear-preferencia.js. Mercado Pago llama esta URL con
// ?type=payment&data.id=<paymentId> (o el formato viejo ?topic=payment&id=...).
//
// Requiere MP_ACCESS_TOKEN y SUPABASE_SERVICE_ROLE_KEY (pedidos_online no
// acepta UPDATE con la llave anónima).
const { aplicarPago } = require('../lib/mp-pago.js');

module.exports = async function handler(req, res) {
  // Mercado Pago solo necesita un 200 de vuelta; nunca fallar con un status
  // de error o reintentará indefinidamente notificaciones que ya no aplican.
  res.setHeader('Access-Control-Allow-Origin', '*');

  const accessToken = process.env.MP_ACCESS_TOKEN;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const paymentId = req.query['data.id'] || req.query.id || (req.body && req.body.data && req.body.data.id);
  const topic = req.query.type || req.query.topic || (req.body && req.body.type);

  if (!accessToken || !serviceRoleKey || !paymentId || topic !== 'payment') {
    res.status(200).json({ received: true });
    return;
  }

  try {
    await aplicarPago({ accessToken, serviceRoleKey, paymentId });
  } catch (e) { /* se responde 200 igual */ }
  res.status(200).json({ received: true });
};
