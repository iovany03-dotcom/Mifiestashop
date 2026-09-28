// TEMPORAL (quitar cuando se confirme el puente): revisa que la copia
// automática siga llegando a PrestaShop como la tienda 50 ahora que
// mifiestashop.com apunta a Vercel (ver lib/ps-http.js). Devuelve solo
// códigos, ids e id_shop — nunca la llave ni el contenido.
const { prestashopFetch } = require('../lib/ps-http.js');

// ?sitemap=1: ligas públicas del sitemap de PrestaShop (tienda 50), para
// comparar con las que arma el sitio nuevo. Solo URLs públicas.
async function sitemapUrls() {
  const base = 'https://www.mifiestashop.com';
  const get = async u => { const r = await prestashopFetch(u); return { status: r.status, text: r.ok ? await r.text() : '' }; };
  const robots = await get(`${base}/robots.txt`);
  let maps = (robots.text.match(/^sitemap:\s*(\S+)/gim) || []).map(l => l.replace(/^sitemap:\s*/i, '').trim());
  if (!maps.length) maps = [`${base}/1_index_sitemap.xml`, `${base}/sitemap.xml`];
  const seen = new Set(); const urls = []; const tried = [];
  const queue = [...maps];
  while (queue.length && tried.length < 40) {
    const u = queue.shift();
    if (seen.has(u)) continue; seen.add(u);
    let r; try { r = await get(u.replace(/^https?:\/\/(www\.)?mifiestashop\.com/, base)); } catch (e) { tried.push({ u, error: String(e.message).slice(0, 80) }); continue; }
    tried.push({ u, status: r.status });
    const locs = (r.text.match(/<loc>([^<]+)<\/loc>/g) || []).map(x => x.replace(/<\/?loc>/g, '').trim());
    if (/<sitemapindex/i.test(r.text)) queue.push(...locs); else urls.push(...locs);
  }
  return { robots_status: robots.status, tried, count: urls.length, urls };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.query && req.query.sitemap === '1') {
    try { res.status(200).json(await sitemapUrls()); } catch (e) { res.status(200).json({ error: String(e.message || e).slice(0, 200) }); }
    return;
  }
  const key = process.env.PS_API_KEY;
  if (!key) { res.status(500).json({ error: 'sin PS_API_KEY' }); return; }
  const base = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const out = { puente: !!process.env.PS_ORIGIN_IP, base_host: new URL(base).hostname };
  try {
    const r = await prestashopFetch(`${base}/api/orders?display=${encodeURIComponent('[id,id_shop]')}&sort=${encodeURIComponent('[id_DESC]')}&limit=0,3&output_format=JSON&ws_key=${key}`);
    out.status = r.status;
    if (r.ok) out.orders = ((await r.json()).orders || []).map(o => ({ id: Number(o.id), id_shop: Number(o.id_shop) }));
  } catch (e) { out.error = String(e.code || e.message || e).slice(0, 160); }
  res.status(200).json(out);
};
