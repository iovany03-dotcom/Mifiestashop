// Vercel serverless function: generates sitemap.xml with the homepage and
// every real product URL (mirrored to the mifiestashop.vercel.app domain).
module.exports = async function handler(req, res) {
  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const siteOrigin = 'https://mifiestashop.vercel.app';

  const urls = [{ loc: `${siteOrigin}/`, priority: '1.0' }];
  const cmsPages = require('../data/cms-manifest.json');
  cmsPages.forEach(page => urls.push({ loc: `${siteOrigin}${page.path}`, priority: '0.7' }));

  if (process.env.PS_NATIVE_COMMERCE === '1') {
    try {
      const products = await require('../lib/native-catalog').catalog();
      products.forEach(product => urls.push({ loc: `${siteOrigin}${product.url}`, priority: '0.8' }));
    } catch (error) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).send('Sitemap temporalmente no disponible');
    }
  } else if (apiKey) {
    try {
      const auth = Buffer.from(`${apiKey}:`).toString('base64');
      const fields = '[id,link_rewrite]';
      for (let offset = 0; ; offset += 500) {
      const url = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&filter[active]=1&sort=[id_ASC]&limit=${offset},500&output_format=JSON`;
      const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!r.ok) throw new Error('No se pudo obtener el catálogo completo');
      if (r.ok) {
        const data = await r.json();
        const products = Array.isArray(data.products) ? data.products : [];
        products.forEach(p => {
          const rewrite = Array.isArray(p.link_rewrite) ? (p.link_rewrite[0]?.value || p.link_rewrite[0]) : p.link_rewrite;
          if (p.id && rewrite) {
            urls.push({ loc: `${siteOrigin}/${p.id}-${rewrite}.html`, priority: '0.8' });
          }
        });
        if (products.length < 500) break;
      }
      }
    } catch (e) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).send('Sitemap temporalmente no disponible');
    }
  }

  const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${escapeXml(u.loc)}</loc><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.status(200).send(xml);
};
