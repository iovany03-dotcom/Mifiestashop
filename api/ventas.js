// Vercel serverless function: ventas (MXN, pedidos confirmados) en un rango de
// fechas: el histórico de PrestaShop copiado en Supabase (ps_pedidos), los
// pedidos de la tienda en línea (pedidos_online) y los tickets del POS propio
// (pos_tickets).

// La tienda de cada pedido es el empleado (caja) que lo registró. Sin
// empleado = tienda en línea; cualquier otro empleado se agrupa en "Otros".
const { sbGetAll } = require('../lib/catalogo-supabase.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const PAGADOS_ONLINE = ['Pago aceptado', 'Pagado', 'En preparación', 'Enviado', 'Entregado'];

const STORE_BY_EMPLOYEE = { 225: 'CDMX Rumania', 226: 'Querétaro', 230: 'Puebla', 227: 'Atizapán' };
const ONLINE_STORE = 'Tienda en línea';
const OTHER_STORE = 'Otros';

// Los tickets del POS propio (pos_tickets) guardan la sucursal como el texto del
// selector del POS ("Bodega Principal (Rumania)", "Puebla", "Querétaro"); se
// agrupan con el id de la caja de esa sucursal, igual que los pedidos de PrestaShop.
function ticketEmployeeId(almacen) {
  const n = String(almacen || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/rumania|cdmx|popocatepetl/.test(n)) return 225;
  if (/queretaro/.test(n)) return 226;
  if (/puebla/.test(n)) return 230;
  if (/atizapan/.test(n)) return 227;
  return -1;
}

function storeOf(order) {
  const id = parseInt(order.id_employee, 10) || 0;
  if (!id) return ONLINE_STORE;
  return STORE_BY_EMPLOYEE[id] || OTHER_STORE;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

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

  try {
    // Pedidos históricos de PrestaShop (ps_pedidos): válidos y en pesos;
    // date_add se guarda con la hora local de la tienda.
    const orders = await sbGetAll(
      `ps_pedidos?select=id,total_paid,date_add,id_employee&valid=is.true&or=(id_currency.eq.3,id_currency.is.null)` +
      `&date_add=gte.${encodeURIComponent(fromDt)}&date_add=lte.${encodeURIComponent(toDt)}&order=id.asc`
    );
    // Pedidos de la tienda propia (checkout público / manuales / API) en
    // pedidos_online: cuentan los que tienen pago validado; la fecha se toma
    // en hora de México.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      const estados = PAGADOS_ONLINE.map(s => `"${s}"`).join(',');
      const sbUrl = `${SUPABASE_URL}/rest/v1/pedidos_online?select=folio,total,created_at` +
        `&status=in.(${encodeURIComponent(estados)})` +
        `&created_at=gte.${encodeURIComponent(from + 'T00:00:00-06:00')}` +
        `&created_at=lte.${encodeURIComponent(to + 'T23:59:59-06:00')}&order=created_at.asc&limit=10000`;
      const r = await fetch(sbUrl, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!r.ok) throw new Error(`pedidos_online error ${r.status}`);
      const rows = await r.json();
      rows.forEach(o => {
        const local = new Date(o.created_at).toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' });
        orders.push({ id: o.folio, total_paid: o.total, date_add: local, id_employee: 0 });
      });

      // Ventas del POS propio (pos_tickets). Los tickets que ya tienen pedido en
      // PrestaShop (ps_order_id) están contados arriba: se excluyen para no
      // duplicarlos.
      const tUrl = `${SUPABASE_URL}/rest/v1/pos_tickets?select=folio,total,almacen,created_at&ps_order_id=is.null` +
        `&created_at=gte.${encodeURIComponent(from + 'T00:00:00-06:00')}` +
        `&created_at=lte.${encodeURIComponent(to + 'T23:59:59-06:00')}&order=created_at.asc&limit=10000`;
      const tr = await fetch(tUrl, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!tr.ok) throw new Error(`pos_tickets error ${tr.status}`);
      (await tr.json()).forEach(t => {
        const local = new Date(t.created_at).toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' });
        orders.push({ id: t.folio, total_paid: t.total, date_add: local, id_employee: ticketEmployeeId(t.almacen) });
      });
    }

    const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_paid || 0), 0);
    const count = orders.length;
    const avgTicket = count > 0 ? revenue / count : 0;

    // Desglose para la gráfica: por día si el rango es corto, por mes si es largo.
    const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    const granularity = spanDays > 62 ? 'month' : 'day';
    const buckets = {};
    orders.forEach(o => {
      const d = String(o.date_add || '');
      const key = granularity === 'month' ? d.slice(0, 7) : d.slice(0, 10);
      if (!buckets[key]) buckets[key] = { revenue: 0, orders: 0 };
      buckets[key].revenue += parseFloat(o.total_paid || 0);
      buckets[key].orders += 1;
    });
    const breakdown = Object.keys(buckets).sort().map(key => ({
      label: key,
      revenue: Math.round(buckets[key].revenue * 100) / 100,
      orders: buckets[key].orders,
    }));

    const stores = {};
    [...Object.values(STORE_BY_EMPLOYEE), ONLINE_STORE].forEach(name => { stores[name] = { revenue: 0, orders: 0 }; });
    orders.forEach(o => {
      const name = storeOf(o);
      if (!stores[name]) stores[name] = { revenue: 0, orders: 0 };
      stores[name].revenue += parseFloat(o.total_paid || 0);
      stores[name].orders += 1;
    });
    const byStore = Object.entries(stores)
      .filter(([name, s]) => name !== OTHER_STORE || s.orders > 0)
      .map(([store, s]) => ({
        store,
        revenue: Math.round(s.revenue * 100) / 100,
        orders: s.orders,
        avgTicket: s.orders > 0 ? Math.round((s.revenue / s.orders) * 100) / 100 : 0,
        share: revenue > 0 ? Math.round((s.revenue / revenue) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.status(200).json({
      from,
      to,
      byStore,
      revenue: Math.round(revenue * 100) / 100,
      orders: count,
      avgTicket: Math.round(avgTicket * 100) / 100,
      currency: 'MXN',
      granularity,
      breakdown,
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar ventas en Supabase', detail: String(err) });
  }
};
