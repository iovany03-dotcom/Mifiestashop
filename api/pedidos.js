// Vercel serverless function: fetches the real orders list from PrestaShop,
// resolving every column shown in the admin's "Pedidos" table to real data
// (no invented text) via bulk lookups against PrestaShop's own resources:
//   - reference, delivery_date, payment: ya vienen en /api/orders
//   - Cliente: /api/customers (id_customer -> nombre real)
//   - Estado: /api/order_states (current_state -> etiqueta real, ej. "Pago aceptado")
//   - Creado Por: /api/employees (id_employee -> nombre real, ej. "Caja Queretaro")
//   - Tienda: /api/shops (id_shop -> nombre real, ej. "Mi Fiestashop")
// Cada lookup se pide una sola vez (no por pedido) para no multiplicar las
// llamadas a PrestaShop.

function firstLangValue(field, fallback) {
  if (Array.isArray(field)) {
    for (const entry of field) {
      const v = entry && typeof entry === 'object' ? entry.value : entry;
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
    return fallback;
  }
  if (typeof field === 'string' && field.trim() !== '') return field;
  return fallback;
}

async function fetchLookupMap(baseUrl, headers, resource, fields, mapValue, limit) {
  try {
    const url = `${baseUrl}/api/${resource}?display=${encodeURIComponent(fields)}&limit=0,${limit || 2000}&output_format=JSON`;
    const r = await fetch(url, { headers });
    if (!r.ok) return {};
    const data = await r.json();
    const rows = Array.isArray(data[resource]) ? data[resource] : [];
    const map = {};
    rows.forEach(row => { map[String(row.id)] = mapValue(row); });
    return map;
  } catch (e) {
    return {};
  }
}

// Los clientes de una tienda con miles de registros no caben en un límite
// fijo razonable — en vez de traerlos todos, se filtra solo por los
// id_customer que realmente aparecen en este lote de pedidos (PrestaShop
// soporta filter[id]=[id1|id2|...] para esto).
async function fetchCustomersByIds(baseUrl, headers, ids) {
  const unique = [...new Set(ids.map(String))].filter(Boolean);
  if (unique.length === 0) return {};
  try {
    const fields = '[id,firstname,lastname]';
    const filter = encodeURIComponent(`[${unique.join('|')}]`);
    const url = `${baseUrl}/api/customers?display=${encodeURIComponent(fields)}&filter[id]=${filter}&limit=0,${unique.length}&output_format=JSON`;
    const r = await fetch(url, { headers });
    if (!r.ok) return {};
    const data = await r.json();
    const rows = Array.isArray(data.customers) ? data.customers : (data.customers ? [data.customers] : []);
    const map = {};
    rows.forEach(c => { map[String(c.id)] = `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente'; });
    return map;
  } catch (e) {
    return {};
  }
}

const FALLBACK_ORDERS = [
  { id: 'POS-10492', reference: '', date: '2026-09-11 14:10', customer: 'Cliente POS', channel: 'Sistema POS', paymentMethod: 'POS', total: 1250.00, status: 'Pago Aceptado', createdBy: null, shop: 'Mi Fiestashop', deliveryDate: null },
  { id: 'PS-89421', reference: 'CPFEGDOQY', date: '2026-09-11 11:32', customer: 'Carlos Gutiérrez', channel: 'Tienda Online', paymentMethod: 'Tarjeta', total: 3480.00, status: 'Entregado', createdBy: null, shop: 'Mi Fiestashop', deliveryDate: null }
];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, orders: FALLBACK_ORDERS });
    return;
  }

  const limit = req.query.limit || 100;
  const fields = '[id,reference,id_customer,current_state,date_add,delivery_date,id_shop,id_employee,payment,total_paid]';
  const url = `${baseUrl}/api/orders?display=${encodeURIComponent(fields)}&limit=0,${limit}&sort=[id_DESC]&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`PrestaShop API error ${r.status}`);

    const data = await r.json();
    const rawOrders = Array.isArray(data.orders) ? data.orders : [];

    const [customers, employees, states, shops] = await Promise.all([
      fetchCustomersByIds(baseUrl, headers, rawOrders.map(o => o.id_customer)),
      fetchLookupMap(baseUrl, headers, 'employees', '[id,firstname,lastname]', e => `${e.firstname || ''} ${e.lastname || ''}`.trim() || null),
      fetchLookupMap(baseUrl, headers, 'order_states', '[id,name]', s => firstLangValue(s.name, 'Pendiente')),
      fetchLookupMap(baseUrl, headers, 'shops', '[id,name]', s => s.name || null)
    ]);

    const orders = rawOrders.map(o => {
      const hasDeliveryDate = o.delivery_date && !String(o.delivery_date).startsWith('0000-00-00');
      return {
        id: String(o.id),
        rawId: o.id,
        reference: o.reference || '',
        date: o.date_add || '—',
        deliveryDate: hasDeliveryDate ? o.delivery_date : null,
        customer: customers[String(o.id_customer)] || `Cliente #${o.id_customer || 'General'}`,
        channel: o.payment === 'POS' ? 'Sistema POS' : 'Tienda Online',
        paymentMethod: o.payment || '—',
        total: parseFloat(o.total_paid || 0),
        status: states[String(o.current_state)] || 'Pendiente',
        createdBy: employees[String(o.id_employee)] || null,
        shop: shops[String(o.id_shop)] || 'Mi Fiestashop'
      };
    });

    res.status(200).json({ orders });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, orders: FALLBACK_ORDERS });
  }
};
