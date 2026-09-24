// Vercel serverless function: sirve robots.txt apuntando al sitemap con el
// dominio real de la petición (igual que api/sitemap.js) — así, el día que
// mifiestashop.com apunte aquí, no hace falta tocar código ni redeploy.
module.exports = async function handler(req, res) {
  const siteOrigin = `https://${req.headers.host}`;
  const body = `User-agent: *
Allow: /

Sitemap: ${siteOrigin}/sitemap.xml
`;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.status(200).send(body);
};
