// Vercel serverless function: detalle de un pedido (líneas de producto +
// datos del cliente) para el modal "Ver Orden", leído desde nuestras
// tablas espejo en Supabase (ps_pedidos.items ya trae las líneas, ps_clientes
// el email/fecha de alta) en vez de PrestaShop en vivo.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) return [];
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'Falta parámetro id' });
    return;
  }

  try {
    const orders = await sbGet(`ps_pedidos?select=id,id_customer,total_paid,total_products,date_add,payment,current_state,items&id=eq.${encodeURIComponent(id)}`);
    const order = orders[0] || null;

    const items = (order && Array.isArray(order.items) ? order.items : []).map(it => ({
      name: it.name || 'Producto',
      sku: it.sku || '',
      qty: it.qty || 1,
      price: it.price || 0,
      total: (it.price || 0) * (it.qty || 1)
    }));

    let customer = null;
    if (order && order.id_customer) {
      const customers = await sbGet(`ps_clientes?select=id,email,date_add,name&id=eq.${order.id_customer}`);
      const c = customers[0];
      if (c) customer = { id: c.id, email: c.email, date_add: c.date_add ? String(c.date_add).slice(0, 10) : null };
    }

    res.status(200).json({ order, items, customer });
  } catch (err) {
    res.status(200).json({ error: err.message, order: null, items: [], customer: null });
  }
};
