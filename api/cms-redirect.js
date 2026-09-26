// Redirección por nombre para las páginas CMS, como hacía PrestaShop: si el
// número de /content/<id>-<slug> no existe, se ignora y se manda (301) a la
// primera página que tenga ese slug. Solo llega aquí lo que no coincidió con
// una ruta exacta de vercel.json, así que un id real nunca se redirige.
const manifest = require('../data/cms-manifest.json');

const NOT_FOUND_HTML = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Página no encontrada | Mi Fiestashop</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:12vh 20px;color:#2e1065"><h1>Página no encontrada</h1><p>La dirección que buscas no existe o cambió.</p><p><a href="/" style="color:#d3007b;font-weight:700">Ir a la tienda</a></p></body></html>';

module.exports = function handler(req, res) {
  let slug = String((req.query && req.query.slug) || '');
  try { slug = decodeURIComponent(slug); } catch (e) { /* se usa tal cual */ }
  const match = manifest.filter(p => p.slug === slug).sort((a, b) => a.id - b.id)[0];
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  if (!match) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(NOT_FOUND_HTML);
    return;
  }
  res.statusCode = 301;
  res.setHeader('Location', match.path);
  res.end();
};
