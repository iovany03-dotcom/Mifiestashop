// Vercel serverless function: fetches PrestaShop CMS pages
// (resource "content_management_system") — used to render pages like
// "Aviso de privacidad", "Políticas de devolución", etc. on the public
// storefront with its own design.
//
// GET /api/paginas            -> { pages: [{ id, title, slug }] }
// GET /api/paginas?slug=xyz   -> { page: { id, title, description, content, slug } }
// GET /api/paginas?id=5       -> { page: { id, title, description, content, slug } }
//
// El listado (sin slug/id) solo devuelve las páginas de "Ayuda y Legal"
// que deben aparecer en el footer de la tienda — se filtra por palabras
// clave en el título para no traer TODAS las páginas CMS que existan en
// PrestaShop. Ajusta FOOTER_PAGE_KEYWORDS si agregas o quitas páginas.
//
// Requires env vars:
//   PS_BASE_URL   e.g. https://www.mifiestashop.com
//   PS_API_KEY    the PrestaShop webservice key

// Palabras clave (sin acentos, en minúsculas) que debe contener el título
// de una página para mostrarse en el footer de la tienda.
const FOOTER_PAGE_KEYWORDS = ['envio gratis', 'privacidad', 'devolucion'];

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, pages: [] });
    return;
  }

  // Extrae el primer valor de un campo multi-idioma de PrestaShop (array u objeto),
  // garantizando que el resultado sea siempre un string usable.
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

  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };
  const { id, slug } = req.query;

  try {
    if (id || slug) {
      let targetId = id;

      if (!targetId && slug) {
        const listUrl = `${baseUrl}/api/content_management_system?display=${encodeURIComponent('[id,link_rewrite,active]')}&output_format=JSON`;
        const lr = await fetch(listUrl, { headers });
        if (!lr.ok) {
          res.status(502).json({ error: `PrestaShop API error ${lr.status}` });
          return;
        }
        const ldata = await lr.json();
        const rows = Array.isArray(ldata.content_management_system) ? ldata.content_management_system : [];
        const match = rows.find(p => firstLangValue(p.link_rewrite, '') === slug && String(p.active) !== '0');
        if (!match) {
          res.status(404).json({ error: 'Página no encontrada' });
          return;
        }
        targetId = match.id;
      }

      const fields = '[id,meta_title,meta_description,content,link_rewrite,active]';
      const url = `${baseUrl}/api/content_management_system/${targetId}?display=${encodeURIComponent(fields)}&output_format=JSON`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        res.status(502).json({ error: `PrestaShop API error ${r.status}` });
        return;
      }
      const data = await r.json();
      const page = data.content_management_system;
      if (!page || String(page.active) === '0') {
        res.status(404).json({ error: 'Página no encontrada' });
        return;
      }

      res.status(200).json({
        page: {
          id: page.id,
          title: firstLangValue(page.meta_title, 'Página'),
          description: firstLangValue(page.meta_description, ''),
          content: firstLangValue(page.content, ''),
          slug: firstLangValue(page.link_rewrite, '')
        }
      });
      return;
    }

    const fields = '[id,meta_title,link_rewrite,active]';
    const url = `${baseUrl}/api/content_management_system?display=${encodeURIComponent(fields)}&filter[active]=1&output_format=JSON`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      res.status(502).json({ error: `PrestaShop API error ${r.status}` });
      return;
    }
    const data = await r.json();
    const rows = Array.isArray(data.content_management_system) ? data.content_management_system : [];
    const pages = rows
      .filter(p => String(p.active) !== '0')
      .map(p => ({
        id: p.id,
        title: firstLangValue(p.meta_title, 'Página'),
        slug: firstLangValue(p.link_rewrite, '')
      }))
      .filter(p => p.slug)
      .filter(p => FOOTER_PAGE_KEYWORDS.some(kw => normalize(p.title).includes(kw)));

    res.status(200).json({ pages });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar API de Páginas PrestaShop', detail: String(err) });
  }
};
