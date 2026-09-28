// TEMPORAL (quitar después del cambio de dominio): revisa desde Vercel qué
// nombres responden como la tienda 50 en el webservice de PrestaShop, para
// poder mover www.mifiestashop.com a Vercel sin romper la copia automática
// (PS_BASE_URL). Solo prueba una lista fija de hosts y devuelve códigos,
// ids e id_shop — nunca la llave ni el contenido.
const HOSTS = ['https://www.mifiestashop.com', 'https://daiscom.mifiestashop.com', 'https://app.daiscom.com'];

async function probe(base, key) {
  const out = { base };
  try {
    const r = await fetch(`${base}/api/orders?display=${encodeURIComponent('[id,id_shop]')}&sort=${encodeURIComponent('[id_DESC]')}&limit=0,5&output_format=JSON&ws_key=${key}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    out.orders_status = r.status;
    if (r.status >= 300 && r.status < 400) out.orders_redirect = String(r.headers.get('location') || '').split('?')[0];
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      out.orders = (d.orders || []).map(o => ({ id: Number(o.id), id_shop: Number(o.id_shop) }));
    }
  } catch (e) { out.orders_error = String(e.message || e).slice(0, 120); }
  try {
    const r = await fetch(`${base}/api/shop_urls?display=${encodeURIComponent('[id_shop,domain,domain_ssl,main,active]')}&output_format=JSON&ws_key=${key}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    out.shop_urls_status = r.status;
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      out.shop_urls_50 = (d.shop_urls || []).filter(u => Number(u.id_shop) === 50);
    }
  } catch (e) { out.shop_urls_error = String(e.message || e).slice(0, 120); }
  return out;
}

// Conexión directa al servidor de PrestaShop (sin pasar por el DNS, que
// ya apunta a Vercel), presentándose como mifiestashop.com.
const https = require('https');
const ORIGIN_IP = '82.29.152.84';
function probeOrigin(hostname, key, verify) {
  return new Promise(resolve => {
    const out = { via: ORIGIN_IP, hostname, verify };
    const path = `/api/orders?display=${encodeURIComponent('[id,id_shop]')}&sort=${encodeURIComponent('[id_DESC]')}&limit=0,3&output_format=JSON&ws_key=${key}`;
    const req = https.request({ host: ORIGIN_IP, port: 443, path, method: 'GET', servername: hostname, headers: { Host: hostname }, rejectUnauthorized: verify, timeout: 15000 }, r => {
      const cert = r.socket.getPeerCertificate ? r.socket.getPeerCertificate() : null;
      out.status = r.statusCode;
      out.cert = cert ? { subject: cert.subject && cert.subject.CN, issuer: cert.issuer && (cert.issuer.O || cert.issuer.CN), valid_to: cert.valid_to, altnames: String(cert.subjectaltname || '').slice(0, 200) } : null;
      out.authorized = r.socket.authorized;
      if (r.statusCode >= 300 && r.statusCode < 400) out.redirect = String(r.headers.location || '').split('?')[0];
      let body = '';
      r.on('data', c => { body += c; if (body.length > 20000) r.destroy(); });
      r.on('end', () => {
        try { out.orders = (JSON.parse(body).orders || []).map(o => ({ id: Number(o.id), id_shop: Number(o.id_shop) })); } catch (e) { out.body_start = body.slice(0, 80).replace(/ws_key=[^&"]*/g, ''); }
        resolve(out);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => { out.error = String(e.code || e.message).slice(0, 120); resolve(out); });
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.PS_API_KEY;
  if (!key) { res.status(500).json({ error: 'sin PS_API_KEY' }); return; }
  const results = await Promise.all(HOSTS.map(h => probe(h, key)));
  const origin = await Promise.all([
    probeOrigin('mifiestashop.com', key, true),
    probeOrigin('www.mifiestashop.com', key, true),
    probeOrigin('mifiestashop.com', key, false)
  ]);
  res.status(200).json({ results, origin });
};
