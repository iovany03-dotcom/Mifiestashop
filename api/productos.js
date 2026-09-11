// Vercel serverless function: fetches products directly from PrestaShop API
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
    // If PS_API_KEY is not set in env, return fallback message or status
    res.status(400).json({ 
      error: 'Falta variable de entorno PS_API_KEY en Vercel',
      message: 'Configure PS_API_KEY en Vercel para sincronizar los productos de PrestaShop en vivo.'
    });
    return;
  }

  const limit = req.query.limit || 500;
  const fields = '[id,name,reference,price,id_default_image,id_category_default,active,description_short,link_rewrite]';
  const url = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&filter[active]=1&limit=0,${limit}&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `PrestaShop API error ${r.status}`, detail: text.slice(0, 500) });
      return;
    }

    const data = await r.json();
    const rawProducts = Array.isArray(data.products) ? data.products : [];

    const products = rawProducts.map(p => {
      // PrestaShop name can be an array of multi-language objects or string
      let nameStr = p.name;
      if (Array.isArray(p.name)) {
        nameStr = p.name[0]?.value || p.name[0] || 'Producto PrestaShop';
      } else if (typeof p.name === 'object' && p.name !== null) {
        nameStr = p.name.value || Object.values(p.name)[0] || 'Producto PrestaShop';
      }

      const imgId = p.id_default_image;
      let imageUrl = 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=300';
      if (imgId && imgId !== '0') {
        imageUrl = `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}`;
      }

      return {
        id: p.id,
        name: nameStr,
        sku: p.reference || `PS-${p.id}`,
        price: parseFloat(p.price || 0),
        categoryId: p.id_category_default || '1',
        img: imageUrl,
        linkRewrite: p.link_rewrite || ''
      };
    });

    res.status(200).json({
      count: products.length,
      products
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar API de Productos PrestaShop', detail: String(err) });
  }
};
