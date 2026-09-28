// Conexión al webservice de PrestaShop después de mover mifiestashop.com a
// Vercel.
//
// PrestaShop (instalación compartida de Daiscom) solo reconoce la tienda 50
// por sus URLs mifiestashop.com / www.mifiestashop.com, y esos nombres ahora
// apuntan a Vercel en el DNS. Con PS_ORIGIN_IP (variable en Vercel, IP del
// servidor de PrestaShop — no va en el repo, que es público) las peticiones
// a esas URLs se conectan directo a ese servidor presentándose con el mismo
// nombre (SNI + Host), así PrestaShop sigue respondiendo como la tienda 50.
//
// El certificado se sigue validando completo (cadena de confianza y
// vigencia); solo el nombre se compara contra el del servidor de Daiscom
// (PS_ORIGIN_CERT_NAME, por defecto daiscom.com), que es el certificado que
// presenta ese servidor para cualquier dominio.
//
// Sin PS_ORIGIN_IP (o para cualquier otro host) es un fetch normal. Para
// regresar el DNS a PrestaShop no hace falta quitarla: sigue funcionando.
const https = require('https');
const tls = require('tls');

const SHOP_HOSTS = ['mifiestashop.com', 'www.mifiestashop.com'];
let agent = null;

function originFor(url) {
  const ip = String(process.env.PS_ORIGIN_IP || '').trim();
  if (!ip) return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !SHOP_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return { ip, url: u };
}

function viaOrigin({ ip, url }, opts = {}) {
  const certName = String(process.env.PS_ORIGIN_CERT_NAME || 'daiscom.com').trim();
  if (!agent) agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip, port: 443, method: opts.method || 'GET', path: url.pathname + url.search,
      servername: url.hostname,
      headers: { ...(opts.headers || {}), Host: url.hostname },
      agent, timeout: 30000,
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(certName, cert)
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: name => { const v = res.headers[String(name).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v ?? null); } },
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('PrestaShop: tiempo de espera agotado')));
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

// Misma forma de uso que fetch(url, { method, headers, body }).
function prestashopFetch(url, opts = {}) {
  const origin = originFor(url);
  return origin ? viaOrigin(origin, opts) : fetch(url, opts);
}

module.exports = { prestashopFetch, originFor };
