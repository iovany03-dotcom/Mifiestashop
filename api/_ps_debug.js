// TEMPORAL: endpoint de diagnóstico para investigar los campos reales que
// PrestaShop necesita para crear un pedido vía webservice antes de escribir
// api/pos-sync-prestashop.js. Se borra antes de abrir el PR final — nunca
// debe llegar a main.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  if (!apiKey) { res.status(400).json({ error: 'PS_API_KEY no configurado' }); return; }
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  async function get(path) {
    try {
      const r = await fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}output_format=JSON`, { headers });
      const text = await r.text();
      try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
      catch (e) { return { ok: r.ok, status: r.status, raw: text.slice(0, 800) }; }
    } catch (e) { return { error: e.message }; }
  }

  const out = {};
  out.customer101973 = await get('/api/customers/101973');
  out.address166996 = await get('/api/addresses/166996');
  out.orderStates = await get('/api/order_states?display=[id,name]&limit=0,60');
  out.carriers = await get('/api/carriers?display=[id,name,active,deleted]&limit=0,20');
  out.employees = await get('/api/employees?display=[id,firstname,lastname,active]&filter[id]=[225|226|227|230]');
  out.orderBlank = await get('/api/orders?schema=blank');
  out.cartBlank = await get('/api/carts?schema=blank');
  out.currencies = await get('/api/currencies?display=[id,name,iso_code,active]&limit=0,10');
  out.languages = await get('/api/languages?display=[id,name,active]&limit=0,10');
  out.shops = await get('/api/shops?display=[id,name,id_shop_group,active]&limit=0,10');
  out.paymentModules = await get('/api/order_payments?limit=0,3');

  res.status(200).json(out);
};
