// Vercel serverless function: detalle de un pedido de PrestaShop (líneas de
// producto + datos del cliente) para el detalle del pedido en el admin,
// leído de las tablas espejo en Supabase (ps_pedidos, ps_clientes).
//
// Trae datos personales del cliente (correo, teléfono, dirección), así que
// requiere la sesión del back office (antes respondía a cualquiera).
//
// POST { p_admin_password, p_staff_email, p_staff_pin, id }
//   -> { order, items, customer }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) return [];
  return r.json();
}

async function checkSession(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null })
  });
  if (!r.ok) return false;
  return !!(await r.json());
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  const id = String(body.id || '');
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Falta el id del pedido' }); return; }

  let ok = false;
  try { ok = await checkSession(body); } catch (e) { ok = false; }
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  try {
    const orders = await sbGet(`ps_pedidos?select=id,reference,id_customer,total_paid,total_products,total_shipping,date_add,payment,payment_method,current_state,note,delivery_date,items&id=eq.${id}`);
    const order = orders[0] || null;

    const items = (order && Array.isArray(order.items) ? order.items : []).map(it => ({
      id: it.id_product || it.id || null,
      name: it.name || 'Producto',
      sku: it.sku || '',
      qty: it.qty || 1,
      price: it.price || 0,
      total: (it.price || 0) * (it.qty || 1)
    }));

    let customer = null;
    if (order && order.id_customer) {
      const customers = await sbGet(`ps_clientes?select=id,email,date_add,name,phone,address,city,postcode&id=eq.${Number(order.id_customer)}`);
      const c = customers[0];
      if (c) customer = {
        id: c.id, email: c.email || null, phone: c.phone || null,
        address: c.address || null, city: c.city || null, postcode: c.postcode || null,
        date_add: c.date_add ? String(c.date_add).slice(0, 10) : null
      };
    }

    res.status(200).json({ order, items, customer });
  } catch (err) {
    res.status(200).json({ error: err.message, order: null, items: [], customer: null });
  }
};
