// Vercel serverless function: ventas REALES por producto, agregadas desde
// las líneas de pedido (order_details) de PrestaShop — no estimación sintética.
//
// 1) Trae los pedidos confirmados en MXN (livianos: solo id + fecha).
// 2) Para esos IDs, trae sus líneas de producto (order_details) en lotes.
// 3) Agrega unidades e ingresos por producto, total y por mes.
//
// Requiere las mismas env vars que /api/ventas.js: PS_BASE_URL, PS_API_KEY.

const BATCH_SIZE = 300;

async function psGet(baseUrl, apiKey, path) {
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const r = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`PrestaShop API ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL;
  const apiKey = process.env.PS_API_KEY;
  if (!baseUrl || !apiKey) {
    res.status(500).json({ error: 'Faltan variables de entorno PS_BASE_URL / PS_API_KEY en Vercel.' });
    return;
  }

  try {
    // 1) Pedidos confirmados en MXN (id_currency=3, valid=1) — solo id y fecha.
    const ordersFields = '[id,date_add]';
    const ordersPath =
      `/api/orders?filter[valid]=1&filter[id_currency]=3&display=${ordersFields}&limit=0,5000&output_format=JSON`
        .replace('filter[valid]', 'filter%5Bvalid%5D')
        .replace('filter[id_currency]', 'filter%5Bid_currency%5D')
        .replace('display=[id,date_add]', 'display=%5Bid,date_add%5D');

    const ordersData = await psGet(baseUrl, apiKey, ordersPath);
    const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
    const orderMonth = {};
    orders.forEach(o => { orderMonth[o.id] = String(o.date_add || '').slice(0, 7); });
    const orderIds = orders.map(o => o.id);

    // 2) Líneas de producto de esos pedidos, en lotes.
    const products = {}; // product_id -> { name, reference, totalUnits, totalRevenue, byMonth }
    let lineItemsProcessed = 0;

    for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
      const batch = orderIds.slice(i, i + BATCH_SIZE);
      const idFilter = encodeURIComponent(`[${batch.join('|')}]`);
      const fields = encodeURIComponent('[id_order,product_id,product_name,product_reference,product_quantity,unit_price_tax_incl]');
      const path = `/api/order_details?display=${fields}&filter%5Bid_order%5D=${idFilter}&limit=0,20000&output_format=JSON`;

      const data = await psGet(baseUrl, apiKey, path);
      let rows = data.order_details;
      if (!rows) rows = [];
      else if (!Array.isArray(rows)) rows = [rows];

      rows.forEach(r => {
        const pid = String(r.product_id || '').trim();
        if (!pid || pid === '0') return;
        const qty = parseFloat(r.product_quantity || 0) || 0;
        const price = parseFloat(r.unit_price_tax_incl || 0) || 0;
        const revenue = qty * price;
        const month = orderMonth[r.id_order] || 'sin-fecha';

        if (!products[pid]) {
          products[pid] = {
            product_id: pid,
            product_name: r.product_name || '',
            product_reference: r.product_reference || '',
            totalUnits: 0,
            totalRevenue: 0,
            byMonth: {},
          };
        }
        const p = products[pid];
        p.totalUnits += qty;
        p.totalRevenue += revenue;
        if (!p.byMonth[month]) p.byMonth[month] = { units: 0, revenue: 0 };
        p.byMonth[month].units += qty;
        p.byMonth[month].revenue += revenue;
        lineItemsProcessed++;
      });
    }

    res.status(200).json({
      products: Object.values(products).sort((a, b) => b.totalUnits - a.totalUnits),
      ordersProcessed: orderIds.length,
      lineItemsProcessed,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ error: 'Fallo al calcular ventas por producto', detail: String(err.message || err) });
  }
};
