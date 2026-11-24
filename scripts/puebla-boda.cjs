// Página de bodas de Puebla (/content/282-articulos-para-boda-en-puebla).
//
// En Search Console la buscan como "recuerdos para boda puebla" (posición ~17), "accesorios para novia
// puebla", "complementos para novias puebla" y "decoración de bodas puebla". Sobre la página que arma
// build-cms.cjs se cambia: título y descripción para esas búsquedas, los paquetes de boda (Jr / Estándar /
// VIP, con precio y contenido vivos vía assets/cms-promo-pricing.js) suben justo después de los beneficios,
// una sección con los accesorios para novios y recuerdos (ligas a los productos reales), las fotos de
// bodas de clientes con su propio título, preguntas frecuentes de boda y datos estructurados.
const { esc } = require('./cms-content.cjs');

const BODA_ID = 282;
const TITLE = 'Recuerdos y artículos para boda en Puebla | Mi Fiesta Shop';
const DESC = 'Paquetes de batucada para boda, recuerdos, accesorios para novios y luminosos en Puebla. Tienda en 35 Sur 2901, mayoreo desde 3 piezas y envíos.';
const H1 = 'Recuerdos y artículos para boda en Puebla';
const INTRO = 'Todo para la batucada de tu boda en un solo lugar: paquetes listos para la pista, accesorios para los novios, recuerdos para tus invitados y luminosos. Visítanos en la 35 Sur 2901 o pide en línea; precio de mayoreo desde 3 piezas.';

const PAQUETES = [
  ['/promociones/83589-promo-boda-economico.html', 'Promo Boda Jr', 'Globos salchicha, pulseras luminosas, lentes gigantes, collares hawaianos, antifaces, inflables, letreros para selfie y sombreros de novio y novia de hule espuma.'],
  ['/promociones/83552-promo-boda-estandar-.html', 'Promo Boda Estándar', 'Surtido de accesorios inflables, neón, metálicos y de batucada para novios e invitados: recepción, primer bloque de baile y cabina de fotos.'],
  ['/promociones/83591-promo-boda-vip-3245678903456.html', 'Promo Boda VIP', 'Paquete completo de animación: antifaces, pelucas, inflables, lentes, sombreros de hule espuma (incluye modelos de novios), coronas y luminosos LED y cyalume.']
];

const NOVIOS = [
  ['/boda/83423-sombrero-de-hule-espuma-novio-2896934327508.html', 'Sombrero de hule espuma Novio'],
  ['/boda/83424-sombrero-hule-espuma-novia-2896478529316.html', 'Sombrero de hule espuma Novia'],
  ['/boda/83458-diadema-hule-espuma-novio-2037917216287.html', 'Diadema de hule espuma Novio'],
  ['/inicio/83459-diadema-hule-espuma-novia-2037766839745.html', 'Diadema de hule espuma Novia'],
  ['/boda/83665-lente-novia-9830898723514.html', 'Lente Novia'],
  ['/productos/84598-lentes-personalizables-boda-3726341890453.html', 'Lentes personalizables Boda'],
  ['/sombreros-de-tela/83600-sombrero-de-tela-mr-5463447816602.html', 'Sombrero de tela Mr.'],
  ['/sombreros-de-tela/83892-sombrero-de-tela-mrs--5463991087546.html', 'Sombrero de tela Mrs.'],
  ['/boda/83452-sombrero-de-hule-espuma-minnie-novia-2896789371246.html', 'Sombrero Minnie Novia'],
  ['/boda/83451-sombrero-de-hule-espuma-mickey-novio-2896486327045.html', 'Sombrero Mickey Novio']
];
const RECUERDOS = [
  ['/productos/84664-jar-mugs-para-boda-5643276585391.html', 'Jar mugs para boda'],
  ['/boda/83908-tarro-estilo-jar-mason.html', 'Tarro estilo Jar Mason'],
  ['/productos/84665-cilindro-para-boda-5643276585391.html', 'Cilindro para boda'],
  ['/productos/84666-sandalias-para-boda-5643276585391.html', 'Sandalias para boda'],
  ['/productos/84667-pantuflas-para-boda-5643276585391.html', 'Pantuflas para boda'],
  ['/productos/84660-gorras-para-boda-8765435632451.html', 'Gorras para boda']
];
const DECORACION = [
  ['/inicio/85774-set-de-globos-novios.html', 'Set de globos novios'],
  ['/boda/85276-globo-traje-de-novio-.html', 'Globo traje de novio'],
  ['/globos/85277-globo-vestido-de-novia.html', 'Globo vestido de novia'],
  ['/globos/85146-globo-redondo-mi-boda.html', 'Globo redondo Mi Boda'],
  ['/boda/83492-globo-copa-4733983227950.html', 'Globo copa']
];

const FAQ = [
  ['¿Qué paquete de batucada para boda me conviene?', 'El Jr es para empezar la fiesta con lo básico, el Estándar suma más variedad para recepción y pista, y el VIP es el paquete completo con luminosos LED y cyalume. Puedes completar cualquiera con piezas sueltas al precio de mayoreo.'],
  ['¿Tienen recuerdos para boda en Puebla?', 'Sí: jar mugs, tarros, cilindros, sandalias, pantuflas y gorras para boda, además de accesorios personalizables como los lentes de boda. Los encuentras en nuestra tienda de la 35 Sur 2901 o en línea.'],
  ['¿Venden accesorios para la novia y el novio?', 'Sí: sombreros y diademas de hule espuma de novio y novia, lentes de novia, sombreros de tela Mr. y Mrs. y modelos de Mickey y Minnie.'],
  ['¿Hay precio de mayoreo para bodas?', 'Sí. Al comprar 3 piezas o más del mismo producto (12 o 24 en algunos artículos) se aplica el precio de mayoreo. Crea tu cuenta gratis para verlo en línea.'],
  ['¿Puedo recoger mi pedido en Puebla?', 'Sí. Al pagar en línea elige "Recoger en sucursal" y la tienda de Puebla (35 Sur 2901); no pagas envío. También enviamos a todo México, gratis desde $1,500 MXN.'],
  ['¿Dan factura?', 'Sí. En línea marca "Requiero factura (+16% IVA)" al pagar y genera tu CFDI en mifiestashop.com/facturar; en tienda pídela en caja.']
];

const ESTILOS = `<style>.boda-pq{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin:6px 0 18px}
.boda-pq a{display:flex;flex-direction:column;gap:6px;padding:16px;border:1px solid #f0d6e6;border-radius:14px;background:#fff;text-decoration:none;color:#2e1065}.boda-pq a span{font-size:.92rem;color:#5b4b6b}
.boda-lista{margin-block:34px}.boda-lista h3{margin:18px 0 8px;color:#a10060}.boda-chips{display:flex;flex-wrap:wrap;gap:10px;list-style:none;padding:0;margin:0}
.boda-chips a{display:inline-block;padding:8px 14px;border-radius:999px;background:#fdf0f7;color:#a10060;text-decoration:none;font-weight:600}</style>`;

function seccionPaquetes() {
  return `<section class="cms-promotions wrap" id="promociones" aria-labelledby="promotions-title"><div class="store-section-title"><h2 id="promotions-title">Paquetes de batucada para boda</h2><a href="/?vista=promos">Ver promociones y cupones →</a></div>
<p>Tres paquetes listos para encender la pista el día de tu boda. Abajo ves el precio actual y todo lo que incluye cada uno.</p>
<div class="boda-pq">${PAQUETES.map(([u, n, d]) => `<a href="${esc(u)}"><strong>${esc(n)}</strong><span>${esc(d)}</span></a>`).join('')}</div>
<div id="cms-promo-pricing" class="promo-pricing-grid" data-packages="${esc(JSON.stringify([{ id: 83589, tier: 'Jr' }, { id: 83552, tier: 'Estándar' }, { id: 83591, tier: 'VIP' }]))}" aria-live="polite"></div></section>`;
}

function seccionNovios() {
  const chips = arr => `<ul class="boda-chips">${arr.map(([u, n]) => `<li><a href="${esc(u)}">${esc(n)}</a></li>`).join('')}</ul>`;
  return `<section class="wrap boda-lista" aria-labelledby="boda-novios"><h2 id="boda-novios">Accesorios para novios, recuerdos y decoración</h2>
<p>Lo que más piden las parejas de Puebla para la pista, los recuerdos de los invitados y la decoración de la mesa de los novios.</p>
<h3>Para la novia y el novio</h3>${chips(NOVIOS)}
<h3>Recuerdos para tus invitados</h3>${chips(RECUERDOS)}
<h3>Globos y decoración de boda</h3>${chips(DECORACION)}</section>`;
}

function schema(url) {
  return { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', name: TITLE, description: DESC, url, inLanguage: 'es-MX', about: { '@id': 'https://www.mifiestashop.com/content/324-tienda-de-articulos-para-fiesta-puebla#tienda' } },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: 'https://www.mifiestashop.com/' },
      { '@type': 'ListItem', position: 2, name: 'Tienda en Puebla', item: 'https://www.mifiestashop.com/content/324-tienda-de-articulos-para-fiesta-puebla' },
      { '@type': 'ListItem', position: 3, name: 'Bodas', item: url }] },
    { '@type': 'ItemList', name: 'Paquetes y accesorios para boda', itemListElement: [...PAQUETES, ...NOVIOS, ...RECUERDOS].map(([u, n], i) => ({ '@type': 'ListItem', position: i + 1, url: 'https://www.mifiestashop.com' + u, name: n })) },
    { '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }
  ] };
}

function designPueblaBoda(html, model) {
  const url = 'https://www.mifiestashop.com' + model.sourcePath;
  const reemplazar = (re, nuevo) => { if (!re.test(html)) throw new Error(`puebla-boda: no encontré ${re}`); html = html.replace(re, nuevo); };
  reemplazar(/<title>[^<]*<\/title>/, `<title>${esc(TITLE)}</title>`);
  reemplazar(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(DESC)}">`);
  reemplazar(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(TITLE)}">`);
  reemplazar(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(DESC)}">`);
  reemplazar(/<script type="application\/ld\+json">[^<]*<\/script>/, () => `<script type="application/ld+json">${JSON.stringify(schema(url)).replace(/</g, '\\u003c')}</script>${ESTILOS}`);
  reemplazar(/<h1>[^<]*<\/h1><p class="hero-intro">[^<]*<\/p>/, `<h1>${esc(H1)}</h1><p class="hero-intro">${esc(INTRO)}</p>`);
  reemplazar(/<a class="button primary" href="#productos">Explorar productos<\/a>/, '<a class="button primary" href="#promociones">Ver paquetes para boda</a>');
  // Los paquetes suben justo después de los beneficios, seguidos de novios / recuerdos / decoración.
  reemplazar(/<section class="cms-promotions wrap" id="promociones"[\s\S]*?<\/section>/, '');
  reemplazar(/(<section class="wrap" aria-label="Beneficios de compra">[\s\S]*?<\/section>)/, (m) => m + '\n' + seccionPaquetes() + '\n' + seccionNovios());
  // Las fotos de la galería son de bodas de clientes.
  reemplazar(/<h2>Así celebran nuestros clientes<\/h2><p>[^<]*<\/p>/, '<h2>Bodas de nuestros clientes</h2><p>Fotos de bodas animadas con nuestros artículos y opiniones de quienes nos compraron.</p>');
  reemplazar(/<section class="cms-faq wrap"[\s\S]*?<\/section>/, () => `<section class="cms-faq wrap" aria-labelledby="faq-title"><div class="store-section-title"><h2 id="faq-title">Preguntas frecuentes de bodas en Puebla</h2></div><div class="faq-list">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`);
  return html;
}

module.exports = { BODA_ID, TITLE, DESC, H1, FAQ, designPueblaBoda };
