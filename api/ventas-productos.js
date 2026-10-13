// Vercel serverless function: ventas REALES por producto (no estimación
// sintética), por mes: el histórico de pedidos de PrestaShop que quedó
// copiado en Supabase (vista ps_ventas_producto_mes) más los tickets del POS
// propio (pos_ventas_producto_mes).

const { sbGetAll, SUPABASE_URL, SUPABASE_ANON_KEY } = require('../lib/catalogo-supabase.js');

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ps_ventas_producto_mes: líneas de ps_pedidos válidos en pesos, ya
  // agregadas por producto y mes en la base de datos.
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
};
