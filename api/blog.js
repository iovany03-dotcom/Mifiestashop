// Páginas públicas del blog, renderizadas en el servidor (HTML completo para Google):
//   /blog            -> lista (?pagina=N, ?etiqueta=…)
//   /blog/:slug      -> artículo (vercel.json reescribe a /api/blog?slug=…)
//   /blog/rss.xml    -> RSS (/api/blog?rss=1)
// Solo se muestran artículos con estado 'publicado' y fecha de publicación ya cumplida.
const { renderPost, renderLista, render404, renderRss, sbBlog } = require('../lib/blog.js');

const POR_PAGINA = 12;
const CAMPOS_LISTA = 'id,slug,titulo,resumen,imagen,imagen_alt,publicado_at,meta_description';

module.exports = async function handler(req, res) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const html = (code, body, cache = true) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', cache ? 'public, s-maxage=300, stale-while-revalidate=86400' : 'no-store');
    res.status(code).send(body);
  };
  if (!serviceKey) return html(500, render404(), false);
  const ahora = encodeURIComponent(new Date().toISOString());
  const publicados = `estado=eq.publicado&publicado_at=lte.${ahora}`;

  try {
    if (req.query.rss) {
      const posts = await sbBlog(`select=${CAMPOS_LISTA}&${publicados}&order=publicado_at.desc&limit=50`, serviceKey);
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
      return res.status(200).send(renderRss(posts));
    }

    const slug = String(req.query.slug || '').toLowerCase();
    if (slug) {
      if (!/^[a-z0-9-]{1,90}$/.test(slug)) return html(404, render404());
      const [p] = await sbBlog(`select=*&slug=eq.${slug}&${publicados}&limit=1`, serviceKey);
      if (!p) return html(404, render404());
      const relacionados = await sbBlog(`select=${CAMPOS_LISTA}&${publicados}&id=neq.${p.id}&order=publicado_at.desc&limit=3`, serviceKey).catch(() => []);
      return html(200, renderPost(p, relacionados));
    }

    const pagina = Math.max(1, Math.min(500, parseInt(req.query.pagina, 10) || 1));
    const etiqueta = String(req.query.etiqueta || '').trim().slice(0, 60);
    const filtroEt = etiqueta ? `&etiquetas=cs.${encodeURIComponent(JSON.stringify([etiqueta]).replace(/^\[/, '{').replace(/\]$/, '}'))}` : '';
    const posts = await sbBlog(`select=${CAMPOS_LISTA}&${publicados}${filtroEt}&order=publicado_at.desc&offset=${(pagina - 1) * POR_PAGINA}&limit=${POR_PAGINA + 1}`, serviceKey);
    if (pagina > 1 && !posts.length) return html(404, render404());
    return html(200, renderLista(posts.slice(0, POR_PAGINA), { pagina, hayMas: posts.length > POR_PAGINA, etiqueta }));
  } catch (e) {
    return html(500, render404(), false);
  }
};
