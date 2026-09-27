// Vercel serverless function: sirve /admin con el manifest, ícono y nombre
// del back office ya puestos en el HTML.
//
// "Agregar a Inicio" en el iPhone usa la URL de inicio del manifest, no la
// página abierta. Cambiar el <link rel="manifest"> con JavaScript no basta:
// si se entra al admin desde la tienda ("Acceso Administrativo") la página
// no se recarga, y Safari se queda con el manifest de la tienda
// (start_url "/") — el ícono abría la tienda. Aquí el HTML ya sale del
// servidor con manifest-admin.json (start_url "/admin").
const fs = require('fs');
const path = require('path');

let cached = null;

function adminHtml(html) {
  return html
    .replace('<link rel="manifest" href="/manifest.json">', '<link rel="manifest" href="/manifest-admin.json">')
    .replace('<link rel="apple-touch-icon" href="/img/icons/apple-touch-icon.png">', '<link rel="apple-touch-icon" href="/img/icons/admin-apple-touch-icon.png">')
    .replace('<meta name="apple-mobile-web-app-title" content="Mi Fiestashop">', '<meta name="apple-mobile-web-app-title" content="MF Admin">')
    .replace(/<meta name="theme-color" content="[^"]*">/, '<meta name="theme-color" content="#2e1065">')
    .replace(/<meta name="robots" content="[^"]*">/, '')
    .replace('</head>', '<meta name="robots" content="noindex, nofollow">\n</head>');
}

async function loadIndex(req) {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  } catch (e) {
    // Respaldo: el mismo index.html estático del sitio.
    const host = String(req.headers?.host || 'mifiestashop.vercel.app');
    const r = await fetch(`https://${host}/index.html`);
    if (!r.ok) throw new Error(`index.html -> HTTP ${r.status}`);
    return r.text();
  }
}

module.exports = async function handler(req, res) {
  try {
    if (!cached) cached = adminHtml(await loadIndex(req));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.status(200).send(cached);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).send('No se pudo cargar el panel. Intenta de nuevo en unos segundos.');
  }
};

module.exports.adminHtml = adminHtml;
