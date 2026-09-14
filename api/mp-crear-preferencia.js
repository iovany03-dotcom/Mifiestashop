// Vercel serverless function: crea una preferencia de pago de Mercado Pago
// (Checkout Pro) para un pedido del checkout público, y regresa la URL a la
// que hay que redirigir al cliente para que pague.
//
// Requiere esta variable de entorno en Vercel (Project Settings > Environment
// Variables) — el Access Token NUNCA se guarda en el código ni en el repo:
//   MP_ACCESS_TOKEN   Access Token de producción de la app "Mi Fiestashop Web"
//                      en https://www.mercadopago.com.mx/settings/account/credentials
//
// Si la variable no está configurada, responde 200 con error:"..." en vez de
// fallar feo, para que el checkout pueda mostrar un mensaje claro y el
// cliente elija otro método de pago mientras se configura Mercado Pago.
//
// POST /api/mp-crear-preferencia { folio, items, payerEmail, payerName, siteUrl }
//   -> { id, init_point } o { error }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(200).json({ error: 'Mercado Pago no está configurado todavía en el servidor.' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const { folio, items, payerEmail, payerName, siteUrl } = body;
  if (!folio || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Falta "folio" o "items" del pedido' });
    return;
  }

  const origin = (siteUrl || 'https://mifiestashop.vercel.app').replace(/\/$/, '');
  const total = items.reduce((s, i) => s + (Number(i.price) || 0) * Math.max(1, Number(i.qty) || 1), 0);
  const backUrlParams = `mp_folio=${encodeURIComponent(folio)}&mp_total=${encodeURIComponent(total.toFixed(2))}`;

  const preference = {
    items: items.map(i => ({
      title: String(i.name || 'Producto').slice(0, 256),
      quantity: Math.max(1, Number(i.qty) || 1),
      unit_price: Number(i.price) || 0,
      currency_id: 'MXN',
    })),
    payer: payerEmail ? { name: payerName || undefined, email: payerEmail } : undefined,
    external_reference: String(folio),
    back_urls: {
      success: `${origin}/?${backUrlParams}&mp_status=approved`,
      pending: `${origin}/?${backUrlParams}&mp_status=pending`,
      failure: `${origin}/?${backUrlParams}&mp_status=failure`,
    },
    auto_return: 'approved',
    notification_url: `${origin}/api/mp-webhook`,
    statement_descriptor: 'MI FIESTASHOP',
  };

  try {
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preference),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(200).json({ error: data.message || 'Mercado Pago rechazó la preferencia de pago.' });
      return;
    }
    res.status(200).json({ id: data.id, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point });
  } catch (err) {
    res.status(200).json({ error: 'No se pudo conectar con Mercado Pago: ' + String(err.message || err) });
  }
};
