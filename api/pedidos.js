// Vercel serverless function: fetches orders list from PrestaShop API
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({
      fallback: true,
      orders: [
        { id: 'POS-10492', date: '2026-09-11 14:10', customer: 'Cliente Mostrador', channel: 'Sistema POS', total: 1250.00, status: 'Pago Aceptado' },
        { id: 'PS-89421', date: '2026-09-11 11:32', customer: 'Carlos Gutiérrez', channel: 'Tienda Online', total: 3480.00, status: 'Entregado' },
        { id: 'PS-89420', date: '2026-09-10 18:45', customer: 'María López', channel: 'Tienda Online', total: 1850.00, status: 'Pago Aceptado' }
      ]
    });
    return;
  }

  const limit = req.query.limit || 100;
  const fields = '[id,id_customer,total_paid,date_add,payment,valid,current_state]';
  const url = `${baseUrl}/api/orders?display=${encodeURIComponent(fields)}&limit=0,${limit}&sort=[id_DESC]&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) throw new Error(`PrestaShop API error ${r.status}`);

    const data = await r.json();
    const rawOrders = Array.isArray(data.orders) ? data.orders : [];

    const orders = rawOrders.map(o => ({
      id: `PS-${o.id}`,
      rawId: o.id,
      date: o.date_add || '—',
      customer: `Cliente #${o.id_customer || 'General'}`,
      channel: 'Tienda Online',
      paymentMethod: o.payment || 'Tarjeta / Pasarela',
      total: parseFloat(o.total_paid || 0),
      status: o.valid === '1' || o.valid === 1 ? 'Pago Aceptado' : 'Pendiente'
    }));

    res.status(200).json({ orders });
  } catch (err) {
    res.status(200).json({
      fallback: true,
      error: err.message,
      orders: [
        { id: 'POS-10492', date: '2026-09-11 14:10', customer: 'Cliente Mostrador', channel: 'Sistema POS', total: 1250.00, status: 'Pago Aceptado' },
        { id: 'PS-89421', date: '2026-09-11 11:32', customer: 'Carlos Gutiérrez', channel: 'Tienda Online', total: 3480.00, status: 'Entregado' }
      ]
    });
  }
};
