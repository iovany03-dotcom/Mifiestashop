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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.PS_API_KEY;
  if (!key) { res.status(500).json({ error: 'sin PS_API_KEY' }); return; }
  const results = await Promise.all(HOSTS.map(h => probe(h, key)));
  res.status(200).json({ results });
};
