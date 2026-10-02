// Vercel serverless function: ventas REALES por producto, agregadas desde
// las líneas de pedido (order_details) de PrestaShop — no estimación sintética.
//
// 1) Trae los pedidos confirmados en MXN (livianos: solo id + fecha).
// 2) Para esos IDs, trae sus líneas de producto (order_details) en lotes.
// 3) Agrega unidades e ingresos por producto, total y por mes.
//
// Requiere las mismas env vars que /api/ventas.js: PS_BASE_URL, PS_API_KEY.

const { prestashopConectado, sbGetAll, SUPABASE_URL, SUPABASE_ANON_KEY } = require('../lib/prestashop.js');

const BATCH_SIZE = 300;

// Pedidos válidos en pesos en ps_pedidos (solo el conteo, sin traer filas).
async function countValidOrders() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ps_pedidos?select=id&valid=is.true&or=(id_currency.eq.3,id_currency.is.null)&limit=1`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Prefer: 'count=exact' }
  });
  const range = r.headers.get('content-range') || '';
  return parseInt(range.split('/')[1], 10) || 0;
}

// Vista privada pos_ventas_producto_mes (ventas por producto y mes de los tickets
// del POS propio): solo se lee con la llave de servicio. Si falta la llave o
// falla, el resto de las ventas se sigue entregando y se avisa en la respuesta.
async function posVentasPorProducto() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return { ok: false, rows: [], error: 'Falta SUPABASE_SERVICE_ROLE_KEY: no se suman las ventas del POS propio.' };
  const PAGE = 1000, rows = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/pos_ventas_producto_mes?select=product_id,month,product_name,product_reference,units,revenue,lines&order=product_id.asc,month.asc&limit=${PAGE}&offset=${offset}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (!r.ok) throw new Error(`pos_ventas_producto_mes -> HTTP ${r.status}`);
      const page = await r.json();
      if (!Array.isArray(page)) break;
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, rows: [], error: String(e.message || e) };
  }
}

// La key va en la URL (?ws_key=), no en el header Authorization: Basic —
// Daiscom (el proveedor) confirmó que Apache/Cloudflare eliminan ese header
// antes de llegar al webservice, así que siempre daba 401 aunque la key
// fuera válida y estuviera activa.
async function psGet(baseUrl, apiKey, path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${baseUrl}${path}${sep}ws_key=${apiKey}`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`PrestaShop API ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // PrestaShop desconectado (default, ver lib/prestashop.js): mismas cifras
  // desde la vista ps_ventas_producto_mes (líneas de ps_pedidos válidos en
  // pesos, ya agregadas por producto y mes en la base de datos).
  if (!prestashopConectado()) {
    try {
      const [psRows, ordersProcessed, pos] = await Promise.all([
        sbGetAll('ps_ventas_producto_mes?select=product_id,month,product_name,product_reference,units,revenue,lines&order=product_id.asc,month.asc'),
        countValidOrders(),
        posVentasPorProducto()
      ]);
      // Ventas del POS propio (pos_tickets): no pasan por PrestaShop, así que
      // se suman aparte a las de ps_pedidos (los tickets que ya tienen pedido
      // en PrestaShop quedan fuera de la vista para no contarlos dos veces).
      const rows = psRows.concat(pos.rows);
      const products = {};
      let lineItemsProcessed = 0;
      rows.forEach(r => {
        const pid = String(r.product_id);
        if (!products[pid]) {
          products[pid] = { product_id: pid, product_name: r.product_name || '', product_reference: r.product_reference || '', totalUnits: 0, totalRevenue: 0, byMonth: {} };
        }
        const p = products[pid];
        const units = Number(r.units) || 0, revenue = Number(r.revenue) || 0;
        p.totalUnits += units;
        p.totalRevenue += revenue;
        const mes = r.month || 'sin-fecha';
        const prev = p.byMonth[mes] || { units: 0, revenue: 0 };
        p.byMonth[mes] = { units: prev.units + units, revenue: prev.revenue + revenue };
        lineItemsProcessed += Number(r.lines) || 0;
      });
      res.status(200).json({
        products: Object.values(products).sort((a, b) => b.totalUnits - a.totalUnits),
        ordersProcessed,
        lineItemsProcessed,
        generatedAt: new Date().toISOString(),
        source: 'supabase',
        posIncluido: pos.ok,
        ...(pos.error ? { posError: pos.error } : {})
      });
    } catch (err) {
      res.status(502).json({ error: 'Fallo al calcular ventas por producto', detail: String(err.message || err) });
    }
    return;
  }

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
