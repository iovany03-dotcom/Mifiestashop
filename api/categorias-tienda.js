// Vercel serverless function: real PrestaShop categories (curated set) with
// real product counts, used by the public storefront's "Ver todos los
// productos" browse panel and its category sidebar.
const CATEGORIES = [
  { id: 269, name: 'Globos', slug: 'globos' },
  { id: 273, name: 'Batucada', slug: 'batucada' },
  { id: 287, name: 'Boda', slug: 'boda' },
  { id: 279, name: 'Decoración', slug: 'decoracion' },
  { id: 311, name: 'Despedida de Soltera', slug: 'despedida-de-soltera' },
  { id: 304, name: 'Diademas', slug: 'diademas' },
  { id: 271, name: 'Fiesta Mexicana', slug: 'fiesta-mexicana' },
  { id: 294, name: 'Graduaciones', slug: 'graduaciones' },
  { id: 274, name: 'Halloween', slug: 'halloween' },
  { id: 296, name: 'Infantiles', slug: 'infantiles' },
  { id: 303, name: 'Lentes', slug: 'lentes' },
  { id: 268, name: 'Luminosos', slug: 'luminosos' },
  { id: 285, name: 'Navidad', slug: 'navidad' },
  { id: 280, name: 'Pirotecnia Fría', slug: 'pirotecnia' },
  { id: 270, name: 'Velas', slug: 'velas' },
  { id: 286, name: 'Año Nuevo', slug: 'ano-nuevo' },
  { id: 305, name: 'Sombreros', slug: 'sombreros' },
  { id: 272, name: 'Poolparty', slug: 'poolparty' }
];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, categories: CATEGORIES.map(c => ({ ...c, count: 0 })) });
    return;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    const results = await Promise.all(CATEGORIES.map(async (c) => {
      try {
        const fields = '[id,nb_products_recursive]';
        const url = `${baseUrl}/api/categories/${c.id}?display=${encodeURIComponent(fields)}&output_format=JSON`;
        const r = await fetch(url, { headers });
        if (!r.ok) return { ...c, count: 0 };
        const data = await r.json();
        const cat = Array.isArray(data.categories) ? data.categories[0] : data.category;
        const count = parseInt(cat?.nb_products_recursive || 0, 10);
        return { ...c, count };
      } catch (e) {
        return { ...c, count: 0 };
      }
    }));

    res.status(200).json({ categories: results });
  } catch (err) {
    res.status(200).json({ error: err.message, categories: CATEGORIES.map(c => ({ ...c, count: 0 })) });
  }
};
