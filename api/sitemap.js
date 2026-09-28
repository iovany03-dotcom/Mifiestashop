// Vercel serverless function: generates sitemap.xml with the homepage and
// every real product URL.
const { prestashopConectado, fetchCatalogoActivo, sbGetAll } = require('../lib/prestashop.js');
const { productoPath } = require('../lib/url-producto.js');

module.exports = async function handler(req, res) {
  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  // Dinámico según el host real de la petición en vez de quedar fijo a
  // mifiestashop.vercel.app: así, el día que mifiestashop.com apunte aquí,
  // el sitemap ya lista las URLs bajo el dominio correcto sin tocar código.
  const siteOrigin = `https://${req.headers.host}`;

  const urls = [{ loc: `${siteOrigin}/`, priority: '1.0' }];
  const cmsPages = require('../data/cms-manifest.json');
  cmsPages.forEach(page => urls.push({ loc: `${siteOrigin}${page.path}`, priority: '0.7' }));

  if (!prestashopConectado()) {
    // PrestaShop desconectado (default, ver lib/prestashop.js): mismas URLs
    // de producto, desde catalogo_productos (solo los que vienen de
    // PrestaShop, que son los que tienen página /{id}-{link_rewrite}.html).
    try {
      // Misma liga que PrestaShop (/{categoria}/{id}-{link_rewrite}-{ean13}.html,
      // ver lib/url-producto.js): la que Google ya tiene indexada.
      const [rows, cats] = await Promise.all([
        fetchCatalogoActivo('id,link_rewrite,barcode,category_id', '&source=eq.prestashop'),
        sbGetAll('ps_categorias?select=id,link_rewrite&order=id.asc').catch(() => [])
      ]);
      const catRw = new Map(cats.map(c => [String(c.id), c.link_rewrite]));
      rows.forEach(p => {
        const path = productoPath({ id: p.id, linkRewrite: p.link_rewrite, ean13: p.barcode, categoryRewrite: catRw.get(String(p.category_id)) });
        if (path) urls.push({ loc: `${siteOrigin}${path}`, priority: '0.8' });
      });
    } catch (e) { /* fall back to just the homepage */ }
  } else if (apiKey) {
    try {
      // La key va en la URL (?ws_key=), no en el header Authorization:
      // Basic — Daiscom (el proveedor) confirmó que Apache/Cloudflare
      // eliminan ese header antes de llegar al webservice, así que siempre
      // daba 401 aunque la key fuera válida y estuviera activa.
      const fields = '[id,link_rewrite]';
      const url = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&filter[active]=1&limit=0,1000&output_format=JSON&ws_key=${apiKey}`;
      const r = await fetch(url);
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

  const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${escapeXml(u.loc)}</loc><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.status(200).send(xml);
};
