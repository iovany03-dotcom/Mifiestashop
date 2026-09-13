// Vercel serverless function: fetches real shopping carts from PrestaShop
// (resource "carts"), used by "Carritos de Compra" en el Backoffice para
// mostrar carritos activos, abandonados y convertidos en pedido.
//
// Requires env vars:
//   PS_BASE_URL   e.g. https://www.mifiestashop.com
//   PS_API_KEY    the PrestaShop webservice key

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, carts: [] });
    return;
  }

  // Extrae el primer valor de un campo multi-idioma de PrestaShop.
  function firstLangValue(field, fallback) {
    let val = field;
    if (Array.isArray(field)) {
      val = field[0]?.value;
      if (val === undefined) val = field[0];
    } else if (field && typeof field === 'object') {
      val = field.value !== undefined ? field.value : Object.values(field)[0];
    }
    if (typeof val !== 'string' || val === '') return fallback;
    return val;
  }

  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  try {
    const cartsUrl = `${baseUrl}/api/carts?display=[id,id_customer,date_add,date_upd]&sort=[date_upd_DESC]&limit=0,30&output_format=JSON`;
    const ordersUrl = `${baseUrl}/api/orders?display=[id,id_cart,reference]&limit=0,500&output_format=JSON`;
    const customersUrl = `${baseUrl}/api/customers?display=[id,firstname,lastname,email]&limit=0,500&output_format=JSON`;
    const productsUrl = `${baseUrl}/api/products?display=[id,name,reference,price,id_default_image]&limit=0,1000&output_format=JSON`;

    const [cartsRes, ordersRes, customersRes, productsRes] = await Promise.all([
      fetch(cartsUrl, { headers }),
      fetch(ordersUrl, { headers }),
      fetch(customersUrl, { headers }),
      fetch(productsUrl, { headers })
    ]);

    if (!cartsRes.ok) throw new Error(`PrestaShop API error ${cartsRes.status}`);
    const cartsData = await cartsRes.json();
    const rawCarts = Array.isArray(cartsData.carts) ? cartsData.carts : [];

    const orderByCart = {};
    if (ordersRes.ok) {
      const odata = await ordersRes.json();
      const rawOrders = Array.isArray(odata.orders) ? odata.orders : [];
      rawOrders.forEach(o => {
        if (o.id_cart && o.id_cart !== '0') orderByCart[o.id_cart] = o.reference || `#${o.id}`;
      });
    }

    const customerById = {};
    if (customersRes.ok) {
      const cdata = await customersRes.json();
      const rawCust = Array.isArray(cdata.customers) ? cdata.customers : [];
      rawCust.forEach(c => {
        customerById[c.id] = {
          name: `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente',
          email: c.email || ''
        };
      });
    }

    const productById = {};
    if (productsRes.ok) {
      const pdata = await productsRes.json();
      const rawProd = Array.isArray(pdata.products) ? pdata.products : [];
      rawProd.forEach(p => {
        const imgId = p.id_default_image;
        productById[p.id] = {
          name: firstLangValue(p.name, `Producto #${p.id}`),
          sku: p.reference || `PS-${p.id}`,
          price: parseFloat(p.price || 0),
          img: imgId && imgId !== '0' ? `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}` : ''
        };
      });
    }

    const now = Date.now();
    const carts = await Promise.all(rawCarts.map(async (c) => {
      let items = [];
      try {
        const detailUrl = `${baseUrl}/api/carts/${c.id}?output_format=JSON`;
        const dr = await fetch(detailUrl, { headers });
        if (dr.ok) {
          const ddata = await dr.json();
          const rows = ddata.cart?.associations?.cart_rows;
          const rawRows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
          items = rawRows.map(row => {
            const prod = productById[row.id_product] || {};
            return {
              name: prod.name || `Producto #${row.id_product}`,
              sku: prod.sku || '',
              qty: parseInt(row.quantity || 1, 10),
              price: prod.price || 0,
              img: prod.img || ''
            };
          });
        }
      } catch (e) {
        // Sin el detalle del carrito, se muestra sin artículos en vez de fallar todo.
      }

      const customer = customerById[c.id_customer];
      const hoursSinceUpdate = (now - new Date(c.date_upd).getTime()) / 36e5;

      let status = 'active';
      let statusText = 'Activo (En Proceso)';
      if (orderByCart[c.id]) {
        status = 'converted';
        statusText = `Convertido (${orderByCart[c.id]})`;
      } else if (hoursSinceUpdate > 24) {
        status = 'abandoned';
        statusText = 'Abandonado (>24h)';
      }

      return {
        id: `CR-${c.id}`,
        date: c.date_add,
        customer: customer?.name || `Invitado #${c.id}`,
        email: customer?.email || 'invitado.web@mifiestashop.com',
        status,
        statusText,
        items
      };
    }));

    res.status(200).json({ carts });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, carts: [] });
  }
};
