// Vercel serverless function: recibe las notificaciones (webhooks) que manda
// Mercado Pago cuando cambia el estado de un pago, y actualiza el pedido
// correspondiente en la tabla pedidos_online de Supabase.
//
// Configurado como notification_url al crear la preferencia en
// api/mp-crear-preferencia.js. Mercado Pago llama esta URL con
// ?type=payment&data.id=<paymentId> (o el formato viejo ?topic=payment&id=...).
//
// Requiere la misma variable de entorno que api/mp-crear-preferencia.js:
//   MP_ACCESS_TOKEN
//
// Además requiere, SOLO en esta función:
//   SUPABASE_SERVICE_ROLE_KEY   la "service_role" secret key del proyecto
//                                (Supabase Dashboard > Project Settings > API
//                                Keys) — pedidos_online ya no acepta UPDATE
//                                con la llave anónima (se cerró ese acceso
//                                por seguridad), así que este webhook
//                                necesita la llave con privilegios de
//                                servidor para poder marcar un pedido como
//                                pagado/cancelado. Nunca se expone al cliente.

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

const STATUS_MAP = {
  approved: 'Pagado',
  rejected: 'Cancelado',
  cancelled: 'Cancelado',
  refunded: 'Cancelado',
  charged_back: 'Cancelado',
  pending: 'Pendiente',
  in_process: 'Pendiente',
  authorized: 'Pendiente',
};

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
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payment = await r.json();
    if (!r.ok || !payment.external_reference) {
      res.status(200).json({ received: true });
      return;
    }

    const nuevoStatus = STATUS_MAP[payment.status] || 'Pendiente';

    await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online?folio=eq.${encodeURIComponent(payment.external_reference)}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: nuevoStatus, payment_method: 'Mercado Pago' }),
    });

    res.status(200).json({ received: true });
  } catch (e) {
    res.status(200).json({ received: true });
  }
};
