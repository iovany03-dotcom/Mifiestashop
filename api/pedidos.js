// Vercel serverless function: lee los pedidos desde nuestra propia copia en
// Supabase (ps_pedidos), sincronizada cada hora por
// api/cron-sync-prestashop.js — ya no se consulta PrestaShop en cada carga
// de la lista de "Pedidos" (antes hacía varias llamadas en vivo: orders,
// customers, employees, order_states, shops, order_details por cada carga).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// Las cuentas de cajero en PrestaShop se llaman "Caja Puebla", "Caja
// Queretaro", "Caja CDMX" — de ahí se deriva la sucursal real de cada
// venta POS (PrestaShop no tiene un concepto de "tienda física" aparte:
// todas las órdenes son id_shop=50 "Mi Fiestashop").
function sucursalFromEmployee(employeeName) {
  const m = String(employeeName || '').match(/^Caja\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

const FALLBACK_ORDERS = [
  { id: 'POS-10492', reference: '', date: '2026-09-11 14:10', customer: 'Cliente POS', channel: 'Sistema POS', paymentMethod: 'POS', total: 1250.00, status: 'Pago Aceptado', createdBy: null, shop: 'Mi Fiestashop', deliveryDate: null },
  { id: 'PS-89421', reference: 'CPFEGDOQY', date: '2026-09-11 11:32', customer: 'Carlos Gutiérrez', channel: 'Tienda Online', paymentMethod: 'Tarjeta', total: 3480.00, status: 'Entregado', createdBy: null, shop: 'Mi Fiestashop', deliveryDate: null }
];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const limit = parseInt(req.query.limit, 10) || 3000;

  try {
    const select = 'id,reference,customer_name,total_paid,payment,payment_method,state_label,date_add,delivery_date,employee_name,shop_name,items';
    // El límite por defecto de PostgREST (1000 filas) se aplica aunque se
    // pida ?limit= más grande — hay que paginar con el header Range para
    // traer más de 1000 (ver el mismo problema resuelto en api/clientes.js).
    const PAGE_SIZE = 1000;
    let rawOrders = [];
    let from = 0;
    while (rawOrders.length < limit) {
      const remaining = limit - rawOrders.length;
      const to = from + Math.min(PAGE_SIZE, remaining) - 1;
      const url = `${SUPABASE_URL}/rest/v1/ps_pedidos?select=${select}&order=id.desc`;
      const r = await fetch(url, {
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${from}-${to}`
        }
      });
      if (!r.ok) throw new Error(`Supabase error ${r.status}`);
      const batch = await r.json();
      rawOrders = rawOrders.concat(batch);
      if (batch.length < (to - from + 1)) break;
      from = to + 1;
    }

    const orders = rawOrders.map(o => {
      const sucursal = sucursalFromEmployee(o.employee_name);
      return {
        id: String(o.id),
        rawId: o.id,
        reference: o.reference || '',
        date: o.date_add || '—',
        deliveryDate: o.delivery_date || null,
        customer: o.customer_name || 'Cliente PrestaShop',
        channel: o.payment === 'POS' ? 'Sistema POS' : 'Tienda Online',
        paymentMethod: o.payment || '—',
        // Detalle real del método de pago (Efectivo/Débito-Crédito/Transferencia),
        // distinto del canal ("POS") de arriba — viene de order_payments en PrestaShop.
        paymentMethodDetail: o.payment_method || 'Sin definir',
        total: parseFloat(o.total_paid || 0),
        status: o.state_label || 'Pendiente',
        createdBy: o.employee_name || null,
        shop: o.shop_name || 'Mi Fiestashop',
        // Sucursal física real (Puebla/Queretaro/CDMX), derivada de qué caja
        // registró la venta — solo aplica a ventas del Sistema POS.
        sucursal,
        tienda: sucursal ? `Mi Fiesta Shop ${sucursal}` : (o.shop_name || 'Mi Fiestashop'),
        puntoVenta: sucursal ? `Terminal ${sucursal}` : null,
        items: (Array.isArray(o.items) ? o.items : []).map(it => ({
          name: it.name, sku: it.sku, qty: it.qty, price: it.price, total: it.price * it.qty
        }))
      };
    });

    res.status(200).json({ orders, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, orders: FALLBACK_ORDERS });
  }
};
