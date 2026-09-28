// TEMPORAL (quitar cuando se confirme el puente): revisa que la copia
// automática siga llegando a PrestaShop como la tienda 50 ahora que
// mifiestashop.com apunta a Vercel (ver lib/ps-http.js). Devuelve solo
// códigos, ids e id_shop — nunca la llave ni el contenido.
const { prestashopFetch } = require('../lib/ps-http.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
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
