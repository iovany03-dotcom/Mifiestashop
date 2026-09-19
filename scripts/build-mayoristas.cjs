// Genera /mayoristas.html: página de aterrizaje para mayoristas, reutilizando
// el mismo sistema de plantillas/encabezado/pie que las páginas CMS migradas
// (ver build-cms.cjs), pero SIN pasar por data/cms-pages.json ni por un id
// numérico de PrestaShop. El id 417 (mifiestashop.com/content/417-...) sigue
// siendo una página real y activa de PrestaShop, deliberadamente excluida de
// la migración (ver tests/cms.test.cjs) — generarla como estática con ese
// mismo id/URL rompería la edición en vivo de esa página. Esta usa una URL
// propia y limpia en vez de chocar con esa página real.
const fs = require('node:fs');
const path = require('node:path');
const { modelFor, esc } = require('./cms-content.cjs');
const root = path.resolve(__dirname, '..');
const pages = require('../data/cms-pages.json');
const origin = 'https://mifiestashop.vercel.app';
const logo = '/img/cms/logo.webp';
const header = fs.readFileSync(path.join(__dirname, 'cms-header.html'), 'utf8');
const benefits = fs.readFileSync(path.join(__dirname, 'cms-benefits.html'), 'utf8');
const categoryIcons = require('../data/cms-category-icons.json');
const footer = fs.readFileSync(path.join(__dirname, 'cms-footer.html'), 'utf8');

// Contenido basado en las páginas reales de mayoreo de la tienda (id 351,
// "Artículos para fiesta mayoreo"): mismo mensaje y textos, adaptado a esta
// página independiente para mayoristas.
const sourceContent = `<h1>ARTÍCULOS PARA FIESTA AL MAYOREO</h1>
<p>¿Organizas eventos o planeas abrir una tienda?</p><p>Si estás organizando eventos y deseas adquirir productos a precios preferenciales, ¡ponte en contacto con nosotros! Ofrecemos grandes beneficios para negocios que buscan manejar precios de mayoreo. Si estás planeando abrir una tienda o ya tienes una y quieres el mejor aliado para hacer crecer tu negocio, estamos aquí para ayudarte.</p>
<h2>POR QUE NOSOTROS</h2>
<img src="/img/cms/521e8dd609804555.png" alt="" width="512" height="512" /><h3>SOMOS IMPORTADORES</h3><p>Somos importadores directos y fabricantes de todos nuestros productos.</p>
<img src="/img/cms/fd0d5b8a90bffd15.png" alt="" width="512" height="512" /><h3>LA MARCA 1° EN MEXICO</h3><p>Somos la marca número 1 en Mexico en venta y distribucion de articulos para fiesta </p>
<img src="/img/cms/4d375d5549d4ecaa.png" alt="" width="512" height="512" /><h3>TE AYUDAMOS</h3><p>Te ayudamos a que tu negocio tenga los beneficios de nuestros programas de afiliados</p>
<h2>Es necesario registrarse para ver los precios de mayoreo. Hasta un 50% de descuento</h2>
<h2>+ DE 400 ARTICULOS</h2>
<p><a href="/?buscar=fiesta">Ver todos</a></p>`;

const page = {
  id: 'mayoristas',
  title: 'Mayoristas: artículos para fiesta al mayoreo',
  slug: 'mayoristas',
  inFooter: false,
  description: 'Contamos con más de 400 productos para tu fiesta al mayoreo. Somos importadores y mayoristas de artículos para fiesta: regístrate y consulta precios preferenciales desde 3 piezas.',
  sourceContent,
  sourcePath: '/mayoristas',
  sourceStatus: 200,
  sourceWasEmpty: false,
  assetAliases: {},
  vip: null,
  importedAt: '2026-09-17',
  categoryId: null,
  categoryName: null
};

const models = pages.map(p => modelFor(p, pages));
const model = modelFor(page, pages);
// modelFor() siempre deriva heroImage de la primera <img> encontrada en el
// contenido (aquí, el ícono genérico de "Somos importadores") — se
// sobreescribe aparte con el banner real que sí es para esta página.
model.heroImage = '/img/cms/mayoristas-banner.webp';

function faqHtml(p) {
  const items = [
    ['¿Cómo encuentro productos de ' + p.config.label.toLocaleLowerCase('es') + '?', 'Explora los productos de esta página. Abre una ficha para consultar las opciones y los detalles del artículo antes de comprar.'],
    ['¿Puedo comprar desde una pieza?', 'Sí. Puedes comprar por pieza y consultar las condiciones de mayoreo desde 3 piezas en la tienda.'],
    ['¿Dónde consulto precios y disponibilidad?', 'Abre la ficha del producto en el catálogo para consultar su información actual antes de hacer tu pedido.'],
    ['¿Cómo reviso las condiciones de envío?', 'Consulta Política de envíos en el pie de página para revisar las condiciones aplicables a tu compra.'],
    ['¿Cómo obtengo precios de mayoreo?', 'Regístrate desde el ícono de perfil de la tienda. Al comprar 3 piezas o más del mismo producto, el precio de mayoreo se aplica automáticamente.']
  ];
  return '<section class="cms-faq wrap" aria-labelledby="faq-title"><div class="store-section-title"><h2 id="faq-title">Preguntas frecuentes</h2></div><div class="faq-list">' + items.map(([q, a]) => '<details><summary>' + esc(q) + '</summary><p>' + esc(a) + '</p></details>').join('') + '</div></section>';
}

function render(p) {
  const t = p.config;
  const shopLink = '/?buscar=' + encodeURIComponent(t.query);
  const related = [...new Map(models.filter(q => q.theme === 'mayoreo' && !q.sourceWasEmpty).map(q => [q.slug, q])).values()].slice(0, 4);
  const schema = { '@context': 'https://schema.org', '@type': 'WebPage', name: p.title, description: p.description, url: origin + p.sourcePath };
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} | Mi Fiestashop</title><meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${origin}${esc(p.sourcePath)}"><meta name="theme-color" content="#d3007b">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.description)}"><meta property="og:url" content="${origin}${esc(p.sourcePath)}"><meta property="og:image" content="${esc(new URL(p.heroImage || logo, origin).href)}">
<link rel="icon" href="/img/icons/icon-32.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/cms.css"><link rel="stylesheet" href="/assets/cms-header.css"><link rel="stylesheet" href="/assets/cms-storefront.css"><link rel="stylesheet" href="/assets/cms-footer.css"><script defer src="/assets/cms-header.js"></script><script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
<script defer src="/assets/cms-cart.js"></script><script defer src="/assets/cms.js"></script></head>
<body data-cms-id="${p.id}" data-theme="${p.theme}"><a class="skip-link" href="#contenido">Ir al contenido</a>
${header}
<main id="contenido">
<section class="hero ${p.heroImage ? '' : 'hero-text-only'}"><div class="hero-inner wrap"><div class="hero-copy">
${t.tags.length ? `<ul class="topic-tags">${t.tags.map(tag => `<li>${esc(tag)}</li>`).join('')}</ul>` : ''}
<h1>${esc(p.title)}</h1>${p.intro ? `<p class="hero-intro">${esc(p.intro)}</p>` : ''}
<div class="hero-actions"><a class="button primary" href="#productos">Explorar productos</a><a class="button secondary" href="${shopLink}">Ver en la tienda</a></div>
</div>${p.heroImage ? `<figure class="hero-image"><img src="${esc(p.heroImage)}" alt="${esc(p.title)}" fetchpriority="high" width="720" height="560"><figcaption>${esc(t.label)}</figcaption></figure>` : ''}</div></section>
<section class="wrap" aria-label="Beneficios de compra">${benefits}</section>
${t.tags.length ? `<section class="cms-categories wrap" aria-label="Categorías"><div class="store-section-title"><h2>Explora ${esc(t.label.toLocaleLowerCase('es'))}</h2></div><div class="store-cats-grid">${t.tags.map((tag, i) => `<a class="store-cat-card" href="/?buscar=${encodeURIComponent(tag)}"><div class="store-cat-icon" style="background:var(--mf-${['teal', 'pink', 'gold'][i % 3]}-ghost)">${categoryIcons[0]}</div><div class="store-cat-name">${esc(tag)}</div></a>`).join('')}</div></section>` : ''}
<section class="catalog-section" id="productos"><div class="wrap"><div class="section-heading store-section-title"><div><h2>${esc(t.label)} para tu negocio o evento</h2><p>Encuentra las opciones que van con tu estilo.</p></div><a class="text-link" href="${shopLink}">Ver catálogo</a></div><div class="store-prods-grid" id="cms-products" aria-live="polite" data-terms="${esc(JSON.stringify(t.terms))}"><p class="catalog-status">Cargando productos…</p></div><noscript><p><a href="${shopLink}">Consulta los productos en nuestra tienda.</a></p></noscript></div></section>
${p.content.trim() ? `<article class="source-content wrap" aria-label="Información para mayoristas">${p.content}</article>` : ''}
<section class="cms-promotions wrap" id="promociones" aria-labelledby="promotions-title"><div class="store-section-title"><h2 id="promotions-title">Promociones de ${esc(t.label.toLocaleLowerCase('es'))}</h2><a href="/?vista=promos">Ver promociones y cupones →</a></div><div class="promotion-benefits"><a href="/pagina/politica-de-envio-gratis-mi-fiesta-shop"><span>Envío gratis</span><strong>En compras mayores a $1,500 MXN</strong><small>Consulta condiciones de envío</small></a><a href="/?cuenta=1"><span>Precios de mayoreo</span><strong>Desde 3 piezas</strong><small>Regístrate y consulta los precios del catálogo</small></a><a href="/?vista=promos"><span>Promociones y cupones</span><strong>Consulta las ofertas disponibles</strong><small>Revisa sus condiciones en tu cuenta</small></a></div></section>
${faqHtml(p)}
${related.length ? `<section class="related-pages wrap"><h2>Más ideas para tu fiesta</h2><div>${related.map(r => `<a href="${esc(r.sourcePath)}">${esc(r.title)}</a>`).join('')}</div></section>` : ''}
</main>${footer.replace('<!--CMS_LOCATION-->', '')}</body></html>
`;
}

fs.writeFileSync(path.join(root, 'mayoristas.html'), render(model));
console.log('Built /mayoristas.html');
