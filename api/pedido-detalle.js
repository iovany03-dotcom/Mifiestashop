// Vercel serverless function: fetches full detail (order + product lines + customer)
// for a single PrestaShop order, used by the "Ver Orden" modal.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const id = req.query.id;

  if (!id) {
    res.status(400).json({ error: 'Falta parámetro id' });
    return;
  }
  if (!apiKey) {
    res.status(200).json({ fallback: true, order: null, items: [], customer: null });
    return;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    const orderFields = '[id,id_customer,total_paid,total_products,date_add,payment,current_state,id_address_delivery,id_address_invoice]';
    const orderUrl = `${baseUrl}/api/orders/${id}?display=${encodeURIComponent(orderFields)}&output_format=JSON`;
    const orderResp = await fetch(orderUrl, { headers });
    const orderData = orderResp.ok ? await orderResp.json() : null;
    const order = orderData && orderData.order ? orderData.order : null;

    const detailFields = '[product_name,product_reference,product_quantity,unit_price_tax_incl,total_price_tax_incl]';
    const detailUrl = `${baseUrl}/api/order_details?display=${encodeURIComponent(detailFields)}&filter[id_order]=${id}&limit=0,200&output_format=JSON`;
    const detailResp = await fetch(detailUrl, { headers });
    const detailData = detailResp.ok ? await detailResp.json() : null;
    const rawItems = detailData && Array.isArray(detailData.order_details) ? detailData.order_details : [];

    const items = rawItems.map(it => ({
      name: it.product_name || 'Producto',
      sku: it.product_reference || '',
      qty: parseInt(it.product_quantity || 1, 10),
      price: parseFloat(it.unit_price_tax_incl || 0),
      total: parseFloat(it.total_price_tax_incl || 0)
    }));

    let customer = null;
    if (order && order.id_customer) {
      try {
        const custFields = '[id,firstname,lastname,email,date_add,company]';
        const custUrl = `${baseUrl}/api/customers/${order.id_customer}?display=${encodeURIComponent(custFields)}&output_format=JSON`;
        const custResp = await fetch(custUrl, { headers });
        const custData = custResp.ok ? await custResp.json() : null;
        customer = custData && custData.customer ? custData.customer : null;
      } catch (e) { /* customer lookup is best-effort */ }
    }

    res.status(200).json({ order, items, customer });
  } catch (err) {
    res.status(200).json({ error: err.message, order: null, items: [], customer: null });
  }
};
