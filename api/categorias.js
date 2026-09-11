// Vercel serverless function: fetches categories from PrestaShop API
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({
      fallback: true,
      categories: [
        { id: 1, name: 'Globos' },
        { id: 2, name: 'Desechables' },
        { id: 3, name: 'Velas & Pastel' },
        { id: 4, name: 'Disfraces' },
        { id: 5, name: 'Decoración' }
      ]
    });
    return;
  }

  const url = `${baseUrl}/api/categories?display=[id,name,active]&filter[active]=1&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      throw new Error(`PrestaShop API error ${r.status}`);
    }

    const data = await r.json();
    const rawCats = Array.isArray(data.categories) ? data.categories : [];

    const categories = rawCats.map(c => {
      let nameStr = c.name;
      if (Array.isArray(c.name)) nameStr = c.name[0]?.value || c.name[0];
      else if (typeof c.name === 'object' && c.name !== null) nameStr = c.name.value || Object.values(c.name)[0];
      return {
        id: c.id,
        name: nameStr || `Categoría ${c.id}`
      };
    }).filter(c => c.name.toLowerCase() !== 'inicio' && c.name.toLowerCase() !== 'home');

    res.status(200).json({ categories });
  } catch (err) {
    res.status(200).json({
      fallback: true,
      error: err.message,
      categories: [
        { id: 1, name: 'Globos' },
        { id: 2, name: 'Desechables' },
        { id: 3, name: 'Velas & Pastel' },
        { id: 4, name: 'Disfraces' },
        { id: 5, name: 'Decoración' }
      ]
    });
  }
};
