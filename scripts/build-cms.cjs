const fs = require('node:fs');
const path = require('node:path');
const { modelFor, esc } = require('./cms-content.cjs');
const root = path.resolve(__dirname, '..');
const pages = require('../data/cms-pages.json');
const origin = 'https://mifiestashop.vercel.app';
const models = pages.map(page => modelFor(page, pages));
const output = path.join(root, 'cms-pages');
fs.mkdirSync(output, { recursive: true });
const logo = '/img/cms/logo.webp';
const header = fs.readFileSync(path.join(__dirname,'cms-header.html'),'utf8');
const benefits = fs.readFileSync(path.join(__dirname,'cms-benefits.html'),'utf8');
const categoryIcons = require('../data/cms-category-icons.json');
const footer = fs.readFileSync(path.join(__dirname,'cms-footer.html'),'utf8');
function vipHtml(p) {
  if(!p.vip)return '';
  return `<section class="vip-section wrap"><form id="vip-form" data-endpoint="${esc(p.vip.endpoint)}" data-redirect="${esc(p.vip.redirect)}" data-threshold="${p.vip.threshold}"><h2>Beneficio VIP</h2><p>Registra tu compra para recibir tu beneficio.</p><label for="vip-phone">Teléfono (10 dígitos)</label><input id="vip-phone" name="phone" type="tel" autocomplete="tel" required><label for="vip-amount">Monto de compra</label><input id="vip-amount" name="amount" type="number" min="1" step="1" required><div id="vip-email-wrap" hidden><label for="vip-email">Correo electrónico</label><input id="vip-email" name="email" type="email" autocomplete="email"><p class="vip-hint">Si tu compra es menor a $400, te enviamos un cupón del 10% por correo.</p></div><button class="button primary" type="submit">Enviar</button><p id="vip-message" role="status" aria-live="polite"></p></form></section>`;
}
function faqHtml(p) {
 const items=p.vip ? [
 ['¿Qué necesito para registrarme?', 'Ten a la mano tu teléfono y el monto de tu compra. El formulario solicita correo electrónico cuando corresponde.'],
 ['¿Dónde consulto dudas sobre mi registro?', 'Comunícate con Mi Fiesta Shop por WhatsApp desde el enlace de contacto del pie de página.']
 ] : [
 ['¿Cómo encuentro productos de '+p.config.label.toLocaleLowerCase('es')+'?', 'Explora los productos de esta página. Abre una ficha para consultar las opciones y los detalles del artículo antes de comprar.'],
 ['¿Puedo comprar desde una pieza?', 'Sí. Puedes comprar por pieza y consultar las condiciones de mayoreo desde 3 piezas en la tienda.'],
 ['¿Dónde consulto precios y disponibilidad?', 'Abre la ficha del producto en el catálogo para consultar su información actual antes de hacer tu pedido.'],
 ['¿Cómo reviso las condiciones de envío?', 'Consulta Política de envíos en el pie de página para revisar las condiciones aplicables a tu compra.']
 ];
 if(p.location?.address)items.push(['¿Dónde está la tienda'+(p.location.name?' en '+p.location.name:'')+'?',p.location.address+'. Usa el botón Cómo llegar de esta página para consultar la ruta.']);
 return '<section class="cms-faq wrap" aria-labelledby="faq-title"><div class="store-section-title"><h2 id="faq-title">Preguntas frecuentes</h2></div><div class="faq-list">'+items.map(([q,a])=>'<details><summary>'+esc(q)+'</summary><p>'+esc(a)+'</p></details>').join('')+'</div></section>';
}
function render(page) {
  const p = page, t = p.config;
  const shopLink = '/?buscar=' + encodeURIComponent(t.query);
  const informational = p.theme === 'informacion';
  const related = [...new Map(models.filter(q => q.theme === p.theme && q.id !== p.id && q.slug !== p.slug && !q.sourceWasEmpty).map(q=>[q.slug,q])).values()].slice(0,4);
  const schema = {'@context':'https://schema.org','@type':'WebPage', name:p.title, description:p.description, url:origin + p.sourcePath};
  // No organization-wide list of addresses is injected into CMS pages.
  if (p.location?.address) schema.contentLocation = {'@type':'Place', name:`Mi Fiesta Shop ${p.location.name}`, address:p.location.address};
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} | Mi Fiestashop</title><meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${origin}${esc(p.sourcePath)}"><meta name="theme-color" content="#d3007b">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.description)}"><meta property="og:url" content="${origin}${esc(p.sourcePath)}"><meta property="og:image" content="${esc(new URL(p.heroImage || logo,origin).href)}">
<link rel="icon" href="/img/icons/icon-32.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/cms.css"><link rel="stylesheet" href="/assets/cms-header.css"><link rel="stylesheet" href="/assets/cms-storefront.css"><link rel="stylesheet" href="/assets/cms-footer.css"><script defer src="/assets/cms-header.js"></script><script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>
<script defer src="/assets/cms.js"></script>${p.vip ? '<script defer src="/assets/cms-vip.js"></script>' : ''}</head>
<body data-cms-id="${p.id}" data-theme="${p.theme}"><a class="skip-link" href="#contenido">Ir al contenido</a>
${header}
<main id="contenido">
<section class="hero ${p.heroImage ? '' : 'hero-text-only'}"><div class="hero-inner wrap"><div class="hero-copy">
${t.tags.length ? `<ul class="topic-tags">${t.tags.map(tag=>`<li>${esc(tag)}</li>`).join('')}</ul>` : ''}
<h1>${esc(p.title)}</h1>${p.intro ? `<p class="hero-intro">${esc(p.intro)}</p>` : ''}
${!informational ? `<div class="hero-actions"><a class="button primary" href="#productos">Explorar productos</a>${p.location ? '<a class="button secondary" href="#ubicacion">Visita nuestra tienda</a>' : `<a class="button secondary" href="${shopLink}">Ver en la tienda</a>`}</div>` : ''}
${p.location && !p.location.multiple ? `<p class="location-note">${p.location.name ? `Tienda en ${esc(p.location.name)}` : 'Consulta nuestra ubicación'}</p>` : ''}
</div>${p.heroImage ? `<figure class="hero-image"><img src="${esc(p.heroImage)}" alt="${esc(p.title)}" fetchpriority="high" width="720" height="560"><figcaption>${esc(t.label)}</figcaption></figure>` : ''}</div></section>
${!informational ? `<section class="wrap" aria-label="Beneficios de compra">${benefits}</section>` : ''}
${!informational && t.tags.length ? `<section class="cms-categories wrap" aria-label="Categorías"><div class="store-section-title"><h2>Explora ${esc(t.label.toLocaleLowerCase('es'))}</h2></div><div class="store-cats-grid">${t.tags.map((tag,i)=>`<a class="store-cat-card" href="/?buscar=${encodeURIComponent(tag)}"><div class="store-cat-icon" style="background:var(--mf-${['teal','pink','gold'][i%3]}-ghost)">${categoryIcons[p.theme==='boda'?3:p.theme==='globos'?2:p.theme==='xv'?4:p.theme==='neon'?1:0]}</div><div class="store-cat-name">${esc(tag)}</div></a>`).join('')}</div></section>` : ''}
${!informational ? `<section class="catalog-section" id="productos"><div class="wrap"><div class="section-heading store-section-title"><div><h2>${esc(t.label)} para tu celebración</h2><p>Encuentra las opciones que van con tu estilo.</p></div><a class="text-link" href="${shopLink}">Ver catálogo</a></div><div class="store-prods-grid" id="cms-products" aria-live="polite" data-terms="${esc(JSON.stringify(t.terms))}"><p class="catalog-status">Cargando productos…</p></div><noscript><p><a href="${shopLink}">Consulta los productos en nuestra tienda.</a></p></noscript></div></section>` : ''}
${p.vip ? vipHtml(p) : p.content.trim() ? `<article class="source-content wrap ${informational ? 'information-content' : ''}" aria-label="Información de ${esc(p.title)}">${p.content}</article>` : ''}
${p.reviews.length ? `<section class="reviews wrap"><div class="section-heading"><div><h2>Así celebran nuestros clientes</h2><p>Experiencias compartidas con Mi Fiesta Shop.</p></div></div><figure class="reviews-scene"><img src="/img/cms/bade5682e19c05ed.png" alt="Personas celebrando con accesorios de fiesta" loading="lazy" width="1200" height="600"><figcaption>Imagen de ambientación. No representa a quienes escribieron las reseñas.</figcaption></figure><div class="review-grid">${p.reviews.map(r=>`<figure><blockquote>${esc(r.quote)}</blockquote><figcaption>${esc(r.name)}</figcaption></figure>`).join('')}</div></section>` : ''}
${p.location && !p.location.multiple ? `<section class="location-section wrap" id="ubicacion"><div><p class="section-kicker">Te esperamos</p><h2>${p.location.name ? `Visítanos en ${esc(p.location.name)}` : 'Visita nuestra tienda'}</h2>${p.location.address ? `<address>${esc(p.location.address)}</address>` : ''}${p.location.phone ? `<a class="phone" href="tel:${esc(p.location.phone)}">${esc(p.location.phone)}</a>` : ''}</div><a class="button primary" href="${esc(p.location.url)}" target="_blank" rel="noopener noreferrer">Cómo llegar</a></section>` : ''}
${faqHtml(p)}
${!informational && related.length ? `<section class="related-pages wrap"><h2>Más ideas para tu fiesta</h2><div>${related.map(r=>`<a href="${esc(r.sourcePath)}">${esc(r.title)}</a>`).join('')}</div></section>` : ''}
</main>${footer.replace('<!--CMS_LOCATION-->', p.location?.address ? `<address class="info-line">${esc(p.location.name)}: ${esc(p.location.address)}</address>` : '')}</body></html>\n`;
}
const runtime = [];
for (const model of models) {
  const html = render(model);
  fs.writeFileSync(path.join(output, `${model.id}.html`), html);
  runtime.push({id:model.id,title:model.title,slug:model.slug,description:model.description,path:model.sourcePath,
    inFooter:model.inFooter,migrated:true,content:html.match(/<main id="contenido">([\s\S]*?)<\/main>/)[1]});
}
fs.writeFileSync(path.join(root,'data','cms-runtime.json'), JSON.stringify(runtime)+'\n');

// The ID-bearing source path preserves every original page, including duplicate slugs.
// Root and /pagina aliases keep existing Vercel links working and select the first source ID,
// matching the previous API's deterministic behavior. Never normalize the source slug.
const manifest = models.map(p => ({id:p.id,title:p.title,slug:p.slug,path:p.sourcePath,theme:p.theme,inFooter:p.inFooter,categoryId:p.categoryId,categoryName:p.categoryName,
  sourceStatus:p.sourceStatus,sourceWasEmpty:p.sourceWasEmpty,location:p.location}));
fs.writeFileSync(path.join(root,'data','cms-manifest.json'), JSON.stringify(manifest,null,2)+'\n');
const config = JSON.parse(fs.readFileSync(path.join(root,'vercel.json')));
const generated = [];
const seen = new Set();
for (const p of models) {
  const destination = `/cms-pages/${p.id}.html`;
  generated.push({source:p.sourcePath,destination});
  if (!seen.has(p.slug)) {
    generated.push({source:`/${p.slug}`,destination},{source:`/pagina/${p.slug}`,destination});
    seen.add(p.slug);
  }
}
const generatedPaths = new Set(generated.map(r=>r.source));
const kept = config.rewrites.filter(r=>!generatedPaths.has(r.source) && !r.destination.startsWith('/cms-pages/'));
config.rewrites = [...generated, ...kept];
fs.writeFileSync(path.join(root,'vercel.json'), JSON.stringify(config,null,2)+'\n');
console.log(`Built ${models.length} CMS pages; ${seen.size} exact slugs; ${generated.length} routes.`);
console.log(`Locations: ${models.filter(p=>p.location).length}; corrected city mismatches: ${models.filter(p=>p.location?.corrected).length}.`);
