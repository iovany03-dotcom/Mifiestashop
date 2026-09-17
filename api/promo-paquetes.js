// Vercel serverless function: fetches specific promo-package products (Jr/Estándar/VIP
// bundles) live from PrestaShop, by id, for the CMS promotions pricing table. Price and
// item list must always come from PrestaShop directly — hardcoding them in the static
// CMS pages would go stale the moment a real price changes.
//
// Requires env vars:
//   PS_BASE_URL   e.g. https://www.mifiestashop.com
//   PS_API_KEY    the PrestaShop webservice key

function firstLangValue(field, fallback) {
  let val = field;
  if (Array.isArray(field)) {
    val = field[0]?.value;
    if (val === undefined) val = field[0];
  } else if (field && typeof field === 'object') {
    val = field.value !== undefined ? field.value : Object.values(field)[0];
  }
  if (typeof val !== 'string' || val === '') return fallback;
  return val;
}

// A package's real content list usually comes as <li> bullets in the PrestaShop
// description; each <li> becomes one item. If the description has no list markup,
// it falls back to one item per line/sentence so short prose still renders as a list.
function itemsFromDescription(html) {
  const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  if (liMatches.length) return liMatches;
  const plain = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '').trim();
  return plain.split(/\n+/).map(s => s.trim()).filter(Boolean);
}

// Transcribed straight from the real site (mifiestashop.com) at the owner's request,
// since the PrestaShop "Descripción corta" for these products is still the old generic
// placeholder ("Articulos para boda", etc.), not a real item list. Used only when the
// live description has fewer than 2 items — the moment someone fills in the real
// description in the PrestaShop admin, the live one takes over automatically.
const FALLBACK_ITEMS = {
  83589: ['200 Globos salchicha', '50 Pulseras luminosas cyalume', '2 Lentes gigante', '3 Collares hawaianos', '2 Antifaces de cartón metálico', '3 Micrófonos inflables', '3 Guitarras metálicas inflables', '2 Cornetas con mechudo', '2 Letreros selfie', '2 Antifaz carnaval', '2 Mandiles personalizados', '1 Sombrero novia hule espuma', '1 Sombrero novio hule espuma'],
  83552: ['5 Antifaz de cartón metálico', '5 Pelucas metálicas', '1 Globo salchicha (200 pzas)', '2 Micrófonos inflables chicos', '4 Guitarras metálicas inflables', '3 Bombines con peluca metálica', '2 Lentes batucada', '6 Collares de perla', '7 Diademas con pelitos', '2 Sombreros de palma', '1 Máscara de luchador', '5 Corbatas neón', '5 Moños neón', '5 Bombines neón', '2 Lentes gigantes neón', '6 Collares hawaianos neón', '1 Sombrero de hule espuma Novio', '1 Sombrero de hule espuma Novio', '5 Diademas con mechudo', '5 Letreros selfie boda', '1 Pulsera luminosa cyalume (90 pzas)', '4 Lentes luminosos cyalume', '1 Anillo luminoso LED (4 pzas)']
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(400).json({ error: 'Falta variable de entorno PS_API_KEY en Vercel', packages: [] });
    return;
  }

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  if (!ids.length) {
    res.status(400).json({ error: 'Falta el parámetro ids', packages: [] });
    return;
  }

  const fields = '[id,name,price,id_default_image,description,description_short,link_rewrite,active]';
  const url = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&filter[id]=${encodeURIComponent('[' + ids.join('|') + ']')}&limit=0,${ids.length}&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `PrestaShop API error ${r.status}`, detail: text.slice(0, 500), packages: [] });
      return;
    }
    const data = await r.json();
    const raw = Array.isArray(data.products) ? data.products : (data.products ? [data.products] : []);

    const packages = raw.filter(p => p.active === '1' || p.active === 1).map(p => {
      const name = firstLangValue(p.name, '');
      const shortDesc = firstLangValue(p.description_short, '');
      const longDesc = firstLangValue(p.description, '');
      const linkRewrite = firstLangValue(p.link_rewrite, '');
      const imgId = p.id_default_image;
      const img = imgId && imgId !== '0' ? `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}` : '';
      const liveItems = itemsFromDescription(shortDesc || longDesc);
      return {
        id: Number(p.id),
        name,
        price: parseFloat(p.price || 0),
        items: liveItems.length >= 2 ? liveItems : (FALLBACK_ITEMS[p.id] || liveItems),
        img,
        linkRewrite,
        url: linkRewrite ? `${baseUrl}/${p.id}-${linkRewrite}.html` : undefined
      };
    });

    res.status(200).json({ packages });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar API de Productos PrestaShop', detail: String(err), packages: [] });
  }
};
