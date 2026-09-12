// Vercel serverless function: generates sitemap.xml with the homepage and
// every real product URL (mirrored to the mifiestashop.vercel.app domain).
module.exports = async function handler(req, res) {
  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const siteOrigin = 'https://mifiestashop.vercel.app';

  const urls = [{ loc: `${siteOrigin}/`, priority: '1.0' }];

  if (apiKey) {
    try {
      const auth = Buffer.from(`${apiKey}:`).toString('base64');
      const fields = '[id,link_rewrite]';
      const url = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&filter[active]=1&limit=0,1000&output_format=JSON`;
      const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (r.ok) {
        const data = await r.json();
        const products = Array.isArray(data.products) ? data.products : [];
        products.forEach(p => {
          const rewrite = Array.isArray(p.link_rewrite) ? (p.link_rewrite[0]?.value || p.link_rewrite[0]) : p.link_rewrite;
          if (p.id && rewrite) {
            urls.push({ loc: `${siteOrigin}/${p.id}-${rewrite}.html`, priority: '0.8' });
          }
        });
      }
    } catch (e) { /* fall back to just the homepage */ }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.status(200).send(xml);
};
