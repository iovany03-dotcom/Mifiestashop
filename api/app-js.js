// Vercel serverless function: sirve el código de la tienda (el <script> grande de index.html) como
// archivo aparte en /app/<hash>.js (ver "tienda ligera" en middleware.js). Con el hash de su
// contenido en la URL se puede guardar en caché un año: una versión nueva del código trae otro hash.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cache = null; // { hash, codigo }

function cargar() {
  if (cache) return cache;
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].length > 100000) {
      cache = { hash: crypto.createHash('sha1').update(m[1], 'utf8').digest('hex').slice(0, 12), codigo: m[1] };
      return cache;
    }
  }
  throw new Error('No se encontró el código de la tienda en index.html');
}

module.exports = async function handler(req, res) {
  try {
    const { hash, codigo } = cargar();
    const pedido = String((req.query && req.query.h) || '');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // Hash correcto: inmutable. Otro hash (página vieja en caché tras un despliegue): se manda el
    // código actual pero sin guardarlo mucho tiempo.
    res.setHeader('Cache-Control', pedido === hash ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.status(200).send(codigo);
  } catch (e) {
    res.status(500).send(`console.error(${JSON.stringify('No se pudo cargar el código de la tienda: ' + e.message)});`);
  }
};

module.exports.cargar = cargar;
