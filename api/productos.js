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
  const productsUrl = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&filter[active]=1&limit=0,${limit}&output_format=JSON`;

  // Extrae el primer valor de un campo multi-idioma de PrestaShop (array u objeto).
  function firstLangValue(field, fallback) {
    if (!field) return fallback;
    if (Array.isArray(field)) return field[0]?.value || field[0] || fallback;
    if (typeof field === 'object') return field.value || Object.values(field)[0] || fallback;
    return field;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(productsUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `PrestaShop API error ${r.status}`, detail: text.slice(0, 500) });
      return;
    }

    const data = await r.json();
    const rawProducts = Array.isArray(data.products) ? data.products : [];

    const products = rawProducts.map(p => {
      const nameStr = firstLangValue(p.name, 'Producto PrestaShop');
      const descStr = firstLangValue(p.description_short, '').replace(/<[^>]*>/g, '').trim();
      const linkRewrite = firstLangValue(p.link_rewrite, '');

      const imgId = p.id_default_image;
      let imageUrl = 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=300';
      if (imgId && imgId !== '0') {
        imageUrl = `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}`;
      }

      // Liga real y pública del producto en la tienda en vivo (mifiestashop.com).
      const publicUrl = linkRewrite ? `${baseUrl}/${p.id}-${linkRewrite}.html` : `${baseUrl}/index.php?id_product=${p.id}&controller=product`;

      return {
        id: p.id,
        name: nameStr,
        description: descStr,
        sku: p.reference || `PS-${p.id}`,
        price: parseFloat(p.price || 0),
        categoryId: p.id_category_default || '1',
        img: imageUrl,
        linkRewrite,
        url: publicUrl
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
