// Vercel serverless function: aggregates PrestaShop sales (MXN, confirmed orders)
// for a given date range. Keeps the PrestaShop API key server-side only.
//
// Requires env vars (set in Vercel Project Settings -> Environment Variables):
//   PS_BASE_URL   e.g. https://www.mifiestashop.com
//   PS_API_KEY    the PrestaShop webservice key

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const baseUrl = process.env.PS_BASE_URL;
  const apiKey = process.env.PS_API_KEY;

  if (!baseUrl || !apiKey) {
    res.status(500).json({ error: 'Faltan variables de entorno PS_BASE_URL / PS_API_KEY en Vercel.' });
    return;
  }

  const { from, to } = req.query;
  if (!from || !to) {
    res.status(400).json({ error: 'Parámetros requeridos: from, to (YYYY-MM-DD)' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ error: 'Formato de fecha inválido, use YYYY-MM-DD' });
    return;
  }

  const fromDt = `${from} 00:00:00`;
  const toDt = `${to} 23:59:59`;

  const fields = '[id,total_paid,date_add]';
  const url =
    `${baseUrl}/api/orders?` +
    `filter[date_add]=[${encodeURIComponent(fromDt)},${encodeURIComponent(toDt)}]&date=1` +
    `&filter[valid]=1&filter[id_currency]=3` +
    `&display=${encodeURIComponent(fields)}` +
    `&limit=0,5000&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `PrestaShop API error ${r.status}`, detail: text.slice(0, 500) });
      return;
    }
    const data = await r.json();
    const orders = Array.isArray(data.orders) ? data.orders : [];
    const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_paid || 0), 0);
    const count = orders.length;
    const avgTicket = count > 0 ? revenue / count : 0;

    res.status(200).json({
      from,
      to,
      revenue: Math.round(revenue * 100) / 100,
      orders: count,
      avgTicket: Math.round(avgTicket * 100) / 100,
      currency: 'MXN',
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar PrestaShop', detail: String(err) });
  }
};
