// Vercel serverless function: lee los pedidos guardados en pedidos_online
// (checkout público + pedidos creados a mano desde "Pedidos" en el admin).
//
// pedidos_online tiene RLS que bloquea el SELECT con la llave anon (solo
// admite INSERT anónimo desde el checkout, y SELECT autenticado limitado a
// "mis propios pedidos" para el portal de cliente) — por eso este endpoint,
// a diferencia de la mayoría de /api, necesita la llave de servicio para
// poder listar todos los pedidos en el panel de administración.
//
// Requiere la variable de entorno SUPABASE_SERVICE_ROLE_KEY (ya configurada
// en Vercel para api/mp-webhook.js).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    res.status(200).json({ orders: [], error: 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel' });
    return;
  }

  try {
    const select = 'folio,created_at,customer_name,customer_email,customer_phone,shipping_address,billing_address,bodega,nota,delivery_date,payment_method,shipping_carrier,shipping_cost,items,subtotal,discount_amount,discount_label,total,status,created_by,source';
    const url = `${SUPABASE_URL}/rest/v1/pedidos_online?select=${select}&order=created_at.desc&limit=1000`;
    const r = await fetch(url, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!r.ok) throw new Error(`Supabase error ${r.status}`);
    const rows = await r.json();

    const orders = rows.map(o => ({
      id: o.folio,
      reference: o.folio,
      date: o.created_at ? new Date(o.created_at).toLocaleString('es-MX') : '—',
      deliveryDate: o.delivery_date || null,
      customer: o.customer_name || 'Cliente',
      channel: o.source === 'manual' ? 'Pedido Manual' : 'Tienda Online',
      paymentMethod: o.payment_method || '—',
      total: parseFloat(o.total || 0),
      status: o.status || 'Pendiente',
      createdBy: o.created_by || null,
      shop: 'Mi Fiestashop',
      bodega: o.bodega || null,
      nota: o.nota || null,
      shippingAddress: o.shipping_address || null,
      billingAddress: o.billing_address || null,
      shippingCarrier: o.shipping_carrier || null,
      customerEmail: o.customer_email || null,
      customerPhone: o.customer_phone || null,
      items: (Array.isArray(o.items) ? o.items : []).map(it => ({
        name: it.name, sku: it.sku, qty: it.qty, price: it.price, total: it.price * it.qty
      })),
      _sortDate: o.created_at ? new Date(o.created_at).getTime() : 0
    }));

    res.status(200).json({ orders, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ orders: [], error: err.message });
  }
};
