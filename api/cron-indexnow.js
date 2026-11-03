// Vercel Cron (vercel.json, diario 01:10 de México): manda a IndexNow las páginas del sitemap que
// cambiaron desde la última corrida (productos y categorías con updated_at/seo_updated_at nuevos;
// la primera vez, todo el sitemap). Candado: una vez por día en ps_sync_estado ('indexnow').
const { sb, sbTodo, urlsDelSitemap } = require('../lib/seo-datos.js');
const { productoPath } = require('../lib/url-producto.js');
const indexnow = require('../lib/indexnow.js');

const ORIGEN = 'https://www.mifiestashop.com';
const hoyMx = () => Number(new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' }).replace(/-/g, ''));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (expected && (req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    const [estado] = await sb('/rest/v1/ps_sync_estado?dominio=eq.indexnow&select=last_synced_id,last_synced_at');
    if (estado && Number(estado.last_synced_id) === hoyMx()) { res.status(200).json({ ok: true, omitido: 'ya se avisó hoy' }); return; }
    const desde = estado && estado.last_synced_at ? new Date(estado.last_synced_at).toISOString() : null;
    let urls;
    if (!desde) {
      urls = await urlsDelSitemap();
    } else {
      const [prods, cats] = await Promise.all([
        sbTodo(`/rest/v1/catalogo_productos?select=id,link_rewrite,barcode,category_id&active=eq.true&updated_at=gte.${encodeURIComponent(desde)}`),
        sbTodo('/rest/v1/ps_categorias?select=id,link_rewrite,active,seo_updated_at')
      ]);
      const catPorId = new Map(cats.map(c => [Number(c.id), c]));
      urls = prods.map(p => ORIGEN + productoPath({ id: p.id, linkRewrite: p.link_rewrite, ean13: p.barcode, categoryRewrite: (catPorId.get(Number(p.category_id)) || {}).link_rewrite }))
        .concat(cats.filter(c => c.active && c.link_rewrite && c.seo_updated_at && c.seo_updated_at >= desde).map(c => `${ORIGEN}/${c.id}-${c.link_rewrite}`));
      // Solo las que están en el sitemap (públicas e indexables).
      const enSitemap = new Set(await urlsDelSitemap());
      urls = urls.filter(u => enSitemap.has(u));
    }
    const r = urls.length ? await indexnow.avisar(urls) : { enviadas: 0 };
    await sb('/rest/v1/ps_sync_estado?on_conflict=dominio', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ dominio: 'indexnow', last_synced_id: hoyMx(), last_synced_at: new Date().toISOString(), ultimo_resultado: `${r.enviadas} páginas avisadas a IndexNow${desde ? '' : ' (todo el sitemap)'}` }])
    });
    res.status(200).json({ ok: true, ...r, primera_vez: !desde });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
