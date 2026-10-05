// Blog de Mi Fiestashop: utilidades compartidas por api/blog.js (páginas públicas, renderizadas en el
// servidor para que Google lea todo el HTML) y api/blog-admin.js (editor del panel).
// Tabla: blog_posts (docs/supabase-blog.sql). Solo la llave de servicio la lee/escribe.
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://www.mifiestashop.com';
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}

// ---- Limpieza del HTML del artículo ----
// El contenido lo escribe el personal en el editor del panel y se publica tal cual en la tienda, así
// que solo se dejan etiquetas y atributos de texto (nada de scripts, estilos, iframes ni eventos).
const TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'img',
  'blockquote', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'div']);
const VOID = new Set(['br', 'img', 'hr']);
const ATTRS = { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height', 'loading'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] };
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math|form|textarea|select|button)\b[\s\S]*?<\/\1\s*>/gi;

function urlSegura(u, { img = false } = {}) {
  const v = String(u || '').trim().replace(/[\u0000-\u001f\s]+/g, '');
  if (!v) return '';
  if (/^(https?:)?\/\//i.test(v) || v.startsWith('/') || v.startsWith('#')) return v;
  if (!img && /^(mailto:|tel:)/i.test(v)) return v;
  return '';
}

function sanitizeHtml(html) {
  let s = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(DROP_WITH_CONTENT, '');
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tagRaw, attrsRaw) => {
    const tag = tagRaw.toLowerCase();
    if (!TAGS.has(tag)) return '';
    if (m.startsWith('</')) return VOID.has(tag) ? '' : `</${tag}>`;
    const permitidos = ATTRS[tag] || [];
    const out = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = re.exec(attrsRaw))) {
      const name = a[1].toLowerCase();
      if (!permitidos.includes(name)) continue;
      let val = a[3] ?? a[4] ?? a[5] ?? '';
      val = val.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      if (name === 'href') { val = urlSegura(val); if (!val) continue; }
      if (name === 'src') { val = urlSegura(val, { img: true }); if (!val) continue; }
      if (name === 'target') val = val === '_blank' ? '_blank' : '';
      if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') && !/^\d{1,4}$/.test(val)) continue;
      if (val === '' && name !== 'alt') continue;
      out.push(`${name}="${esc(val)}"`);
    }
    if (tag === 'a' && out.some(x => x.startsWith('target='))) out.push('rel="noopener"');
    if (tag === 'img' && !out.some(x => x.startsWith('loading='))) out.push('loading="lazy"');
    return `<${tag}${out.length ? ' ' + out.join(' ') : ''}>`;
  });
}

function textoPlano(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
function palabras(html) { const t = textoPlano(html); return t ? t.split(' ').length : 0; }
function minutosLectura(html) { return Math.max(1, Math.round(palabras(html) / 200)); }

// Agrega id a cada <h2> para el índice del artículo (tabla de contenido con anclas).
function conAnclas(html) {
  const vistos = new Set();
  const indice = [];
  const out = String(html || '').replace(/<h2>([\s\S]*?)<\/h2>/g, (m, inner) => {
    let id = slugify(textoPlano(inner)) || 'seccion';
    while (vistos.has(id)) id += '-2';
    vistos.add(id);
    indice.push({ id, texto: textoPlano(inner) });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  return { html: out, indice };
}

// ---- Plantilla (mismo encabezado/pie que las páginas CMS de la tienda) ----
let layoutCache = null;
function layout() {
  if (layoutCache) return layoutCache;
  const leer = f => { try { return fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8'); } catch (e) { return ''; } };
  layoutCache = { header: leer('cms-header.html'), footer: leer('cms-footer.html') };
  return layoutCache;
}

function fechaLarga(iso) {
  try { return new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (e) { return ''; }
}

const BLOG_CSS = `
.blog-wrap{max-width:780px;margin:0 auto;padding:28px 18px 56px}
.blog-crumbs{font-size:13px;color:#7a6a88;margin-bottom:14px}.blog-crumbs a{color:#7a6a88}
.blog-wrap h1{font-family:Fredoka,Poppins,sans-serif;color:#2e1065;font-size:clamp(26px,4.5vw,40px);line-height:1.15;margin:0 0 12px}
.blog-meta{font-size:13px;color:#7a6a88;margin-bottom:18px}
.blog-cover{width:100%;height:auto;border-radius:16px;margin:0 0 22px;aspect-ratio:16/9;object-fit:cover;background:#f6eef7}
.blog-body{color:#3d2f4a;line-height:1.75;font-size:16.5px}
.blog-body h2{font-family:Fredoka,Poppins,sans-serif;color:#2e1065;font-size:26px;margin:34px 0 10px;scroll-margin-top:90px}
.blog-body h3{color:#2e1065;font-size:20px;margin:24px 0 8px}
.blog-body img{max-width:100%;height:auto;border-radius:12px}
.blog-body a{color:#d3007b}
.blog-body blockquote{border-left:4px solid #d3007b;margin:18px 0;padding:6px 16px;color:#5b4a68;background:#fdf3f9;border-radius:0 10px 10px 0}
.blog-body table{border-collapse:collapse;width:100%;margin:16px 0}.blog-body th,.blog-body td{border:1px solid #eadff0;padding:8px}
.blog-toc{background:#faf6fc;border:1px solid #eadff0;border-radius:12px;padding:14px 18px;margin:0 0 24px;font-size:14.5px}
.blog-toc b{display:block;margin-bottom:6px;color:#2e1065}.blog-toc ol{margin:0;padding-left:20px}.blog-toc a{color:#5b2a86}
.blog-tags{display:flex;flex-wrap:wrap;gap:8px;margin:26px 0 0;padding:0;list-style:none}
.blog-tags a{display:inline-block;background:#fdf3f9;color:#b0006a;border-radius:999px;padding:5px 12px;font-size:13px;text-decoration:none}
.blog-cta{margin:34px 0 0;padding:20px;border-radius:16px;background:linear-gradient(135deg,#fdf3f9,#f3fbfb);text-align:center}
.blog-cta a{display:inline-block;margin-top:10px;background:#d3007b;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600}
.blog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:20px}
.blog-card{display:flex;flex-direction:column;border:1px solid #eadff0;border-radius:16px;overflow:hidden;background:#fff;text-decoration:none;color:inherit;transition:transform .15s}
.blog-card:hover{transform:translateY(-2px)}
.blog-card img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#f6eef7}
.blog-card div{padding:14px 16px 18px}.blog-card h2{font-size:18px;color:#2e1065;margin:0 0 6px;line-height:1.3}
.blog-card p{font-size:14px;color:#5b4a68;margin:0 0 8px;line-height:1.5}.blog-card small{color:#8b7d97}
.blog-pag{display:flex;justify-content:center;gap:12px;margin-top:28px}.blog-pag a{color:#d3007b}
.blog-relacionados{margin-top:40px}.blog-relacionados h2{font-family:Fredoka,Poppins,sans-serif;color:#2e1065}
`;

function pagina({ title, description, canonical, image, jsonLd, body, robots, ogType = 'website' }) {
  const { header, footer } = layout();
  const ld = (Array.isArray(jsonLd) ? jsonLd : [jsonLd]).filter(Boolean)
    .map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}"><meta name="theme-color" content="#d3007b">${robots ? `<meta name="robots" content="${esc(robots)}">` : ''}
<meta property="og:type" content="${ogType}"><meta property="og:site_name" content="Mi Fiestashop"><meta property="og:locale" content="es_MX">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:image" content="${esc(image)}">` : ''}<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/rss+xml" title="Blog de Mi Fiestashop" href="${ORIGIN}/blog/rss.xml">
<link rel="icon" href="/img/icons/icon-32.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/cms.css"><link rel="stylesheet" href="/assets/cms-header.css"><link rel="stylesheet" href="/assets/cms-storefront.css"><link rel="stylesheet" href="/assets/cms-footer.css">
<style>${BLOG_CSS}</style>
<script defer src="/assets/cms-header.js"></script><script defer src="/assets/cms-pixel.js"></script><script defer src="/assets/cms-cart.js"></script><script defer src="/assets/cms.js"></script>
${ld}</head>
<body data-theme="blog"><a class="skip-link" href="#contenido">Ir al contenido</a>
${header}
<main id="contenido">${body}</main>
${footer}
</body></html>`;
}

const ORG = { '@type': 'Organization', name: 'Mi Fiestashop', url: ORIGIN, logo: { '@type': 'ImageObject', url: `${ORIGIN}/img/icons/icon-512.png` } };

function urlPost(p) { return `${ORIGIN}/blog/${p.slug}`; }

function renderPost(p, relacionados = []) {
  const titulo = p.meta_title || p.titulo;
  const desc = p.meta_description || p.resumen || textoPlano(p.contenido).slice(0, 155);
  const { html, indice } = conAnclas(p.contenido);
  const canonical = urlPost(p);
  const terms = [p.palabra_clave, ...(p.etiquetas || [])].filter(Boolean).slice(0, 6);
  const jsonLd = [
    {
      '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.titulo.slice(0, 110), description: desc,
      image: p.imagen ? [p.imagen] : undefined, datePublished: p.publicado_at, dateModified: p.updated_at || p.publicado_at,
      author: p.autor ? { '@type': 'Person', name: p.autor } : ORG, publisher: ORG,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical }, keywords: terms.join(', ') || undefined,
      wordCount: palabras(p.contenido), inLanguage: 'es-MX'
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: `${ORIGIN}/blog` },
        { '@type': 'ListItem', position: 3, name: p.titulo, item: canonical }
      ]
    }
  ];
  const body = `<article class="blog-wrap">
<nav class="blog-crumbs" aria-label="Ruta"><a href="/">Inicio</a> › <a href="/blog">Blog</a> › ${esc(p.titulo)}</nav>
<h1>${esc(p.titulo)}</h1>
<p class="blog-meta">${p.autor ? `Por ${esc(p.autor)} · ` : ''}<time datetime="${esc(p.publicado_at || '')}">${esc(fechaLarga(p.publicado_at))}</time> · ${minutosLectura(p.contenido)} min de lectura</p>
${p.imagen ? `<img class="blog-cover" src="${esc(p.imagen)}" alt="${esc(p.imagen_alt || p.titulo)}" width="1200" height="675" fetchpriority="high">` : ''}
${indice.length >= 3 ? `<nav class="blog-toc" aria-label="Contenido"><b>En este artículo</b><ol>${indice.map(i => `<li><a href="#${i.id}">${esc(i.texto)}</a></li>`).join('')}</ol></nav>` : ''}
<div class="blog-body">${html}</div>
${(p.etiquetas || []).length ? `<ul class="blog-tags">${p.etiquetas.map(t => `<li><a href="/?buscar=${encodeURIComponent(t)}">${esc(t)}</a></li>`).join('')}</ul>` : ''}
<div class="blog-cta"><b>¿Listo para tu fiesta?</b><br>Encuentra todo lo que necesitas al mayoreo y menudeo, con envío a todo México.<br><a href="${terms.length ? `/?buscar=${encodeURIComponent(terms[0])}` : '/266-productos'}">Ver productos</a></div>
</article>
${terms.length ? `<section class="catalog-section" id="productos"><div class="wrap"><div class="section-heading store-section-title"><div><h2>Productos para tu celebración</h2></div><a class="text-link" href="/?buscar=${encodeURIComponent(terms[0])}">Ver catálogo</a></div><div class="store-prods-grid" id="cms-products" aria-live="polite" data-terms="${esc(JSON.stringify(terms))}"><p class="catalog-status">Cargando productos…</p></div></div></section>` : ''}
${relacionados.length ? `<section class="blog-wrap blog-relacionados"><h2>Sigue leyendo</h2><div class="blog-grid">${relacionados.map(tarjeta).join('')}</div></section>` : ''}`;
  return pagina({ title: `${titulo} | Blog Mi Fiestashop`, description: desc, canonical, image: p.imagen, jsonLd, body, ogType: 'article' });
}

function tarjeta(p) {
  return `<a class="blog-card" href="/blog/${esc(p.slug)}">${p.imagen ? `<img src="${esc(p.imagen)}" alt="${esc(p.imagen_alt || p.titulo)}" loading="lazy" width="400" height="225">` : ''}<div><h2>${esc(p.titulo)}</h2>${p.resumen ? `<p>${esc(p.resumen)}</p>` : ''}<small>${esc(fechaLarga(p.publicado_at))}</small></div></a>`;
}

function renderLista(posts, { pagina: num = 1, hayMas = false, etiqueta = '' } = {}) {
  const canonical = `${ORIGIN}/blog${num > 1 ? `?pagina=${num}` : ''}`;
  const title = `Blog de fiestas: ideas, consejos y tendencias${num > 1 ? ` (página ${num})` : ''} | Mi Fiestashop`;
  const description = 'Ideas para decorar, organizar y animar bodas, XV años, cumpleaños y batucadas. Consejos de Mi Fiestashop para que tu fiesta sea inolvidable.';
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Blog', name: 'Blog de Mi Fiestashop', url: `${ORIGIN}/blog`, description, publisher: ORG,
    blogPost: posts.map(p => ({ '@type': 'BlogPosting', headline: p.titulo, url: urlPost(p), datePublished: p.publicado_at, image: p.imagen || undefined }))
  };
  const body = `<section class="blog-wrap" style="max-width:1100px">
<nav class="blog-crumbs" aria-label="Ruta"><a href="/">Inicio</a> › Blog</nav>
<h1>Blog de fiestas${etiqueta ? `: ${esc(etiqueta)}` : ''}</h1>
<p class="blog-meta" style="font-size:15px">Ideas, consejos y tendencias para que tu celebración sea inolvidable.</p>
${posts.length ? `<div class="blog-grid">${posts.map(tarjeta).join('')}</div>` : '<p>Muy pronto publicaremos nuestros primeros artículos.</p>'}
<nav class="blog-pag" aria-label="Páginas">${num > 1 ? `<a href="/blog${num > 2 ? `?pagina=${num - 1}` : ''}" rel="prev">← Más recientes</a>` : ''}${hayMas ? `<a href="/blog?pagina=${num + 1}" rel="next">Anteriores →</a>` : ''}</nav>
</section>`;
  return pagina({ title, description, canonical, jsonLd, body, robots: etiqueta ? 'noindex,follow' : '' });
}

function render404() {
  return pagina({
    title: 'Artículo no encontrado | Blog Mi Fiestashop', description: 'Este artículo no existe o ya no está disponible.',
    canonical: `${ORIGIN}/blog`, robots: 'noindex,follow',
    body: `<section class="blog-wrap"><h1>No encontramos este artículo</h1><p>Puede que se haya movido. <a href="/blog">Ve todos los artículos del blog</a> o <a href="/">vuelve a la tienda</a>.</p></section>`
  });
}

function renderRss(posts) {
  const x = s => esc(s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Blog de Mi Fiestashop</title><link>${ORIGIN}/blog</link><description>Ideas y consejos para fiestas</description><language>es-MX</language>
${posts.map(p => `<item><title>${x(p.titulo)}</title><link>${urlPost(p)}</link><guid>${urlPost(p)}</guid><pubDate>${new Date(p.publicado_at).toUTCString()}</pubDate><description>${x(p.resumen || p.meta_description || '')}</description></item>`).join('\n')}
</channel></rss>`;
}

// Lectura con la llave de servicio (blog_posts no tiene políticas para anon).
async function sbBlog(query, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts?${query}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`blog_posts -> HTTP ${r.status}`);
  return r.json();
}

module.exports = { esc, slugify, sanitizeHtml, textoPlano, palabras, minutosLectura, conAnclas, renderPost, renderLista, render404, renderRss, sbBlog, urlPost, ORIGIN, SUPABASE_URL };
