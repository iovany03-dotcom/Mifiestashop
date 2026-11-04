// SEO local de la tienda de Puebla (C. 35 Sur 2901).
//
// Había 47 páginas CMS "… Puebla" casi iguales (heredadas de PrestaShop / Google Ads) que competían
// entre sí por las mismas búsquedas ("artículos para fiesta puebla", "mi fiesta shop puebla"):
// Google repartía las impresiones entre 3–4 de ellas y ninguna llegaba al 1er lugar.
//
// 1. CONSOLIDAR: cada página repetida se manda (301) a UNA página por intención de búsqueda.
//    Las que se quedan (con más impresiones y mejor posición en Search Console):
//      324 tienda de artículos para fiesta Puebla  -> página principal de la sucursal (hub)
//      405 mayoreo Puebla · 289 batucada Puebla · 282 boda Puebla · 278 XV años Puebla
//      400 cumpleaños Puebla · 300 neón Puebla · 303 pintura neón · 387 hora loca
//      347 sombreros Puebla · 348 sombreros de hule espuma Puebla · 295 registro (VIP)
// 2. HUB (324): ficha completa de la tienda — dirección con C.P., mapa, teléfono, qué se vende,
//    cómo comprar, ligas a cada página de intención y a las categorías, preguntas frecuentes y
//    datos estructurados Store + FAQPage + BreadcrumbList para el mapa y el panel de Google.
const { esc } = require('./cms-content.cjs');

const HUB_ID = 324;
const CONSOLIDAR = {
  // Tienda / artículos para fiesta en Puebla (genéricas) -> hub
  286: 324, 322: 324, 323: 324, 325: 324, 326: 324, 327: 324, 328: 324, 361: 324, 362: 324,
  381: 324, 395: 324, 396: 324, 397: 324, 399: 324, 402: 324,
  // Mayoreo
  398: 405, 401: 405, 403: 405, 404: 405,
  // Batucada
  313: 289, 360: 289, 406: 289, 407: 289,
  // "Batucada boda": la buscan como recuerdos / complementos para boda
  359: 282, 408: 282,
  // Cumpleaños
  356: 400, 383: 400,
  // Neón / flúor / glow
  304: 300, 305: 300, 357: 300, 384: 300, 385: 300, 386: 300, 388: 300, 389: 300
};

const TIENDA = {
  nombre: 'Mi Fiesta Shop Puebla',
  calle: 'C. 35 Sur 2901',
  colonia: 'Santa Cruz Los Ángeles',
  cp: '72400',
  ciudad: 'Heroica Puebla de Zaragoza',
  estado: 'Puebla',
  telefono: '222 983 6256',
  telefonoE164: '+522229836256',
  whatsapp: 'https://wa.me/525612622146',
  lat: 19.0464535,
  lng: -98.2310016,
  mapa: 'https://maps.app.goo.gl/Bs3YzM5CA2e39Guw9'
};

const PAGINAS = [
  [289, 'Artículos para batucada en Puebla', 'Sombreros, lentes, collares, pelucas, antifaces y luminosos para la hora loca.'],
  [405, 'Artículos para fiesta por mayoreo en Puebla', 'Precio de mayoreo desde 3 piezas para eventos, salones y revendedores.'],
  [348, 'Sombreros de hule espuma en Puebla', 'Sombreros gigantes y de personajes para batucada y bodas.'],
  [347, 'Sombreros locos en Puebla', 'Sombreros de tela, vaqueros, bombines y de fantasía.'],
  [282, 'Artículos para boda en Puebla', 'Batucada para boda, recuerdos y complementos para novios.'],
  [278, 'Artículos para XV años en Puebla', 'Coronas, accesorios y luminosos para la noche de tus XV.'],
  [400, 'Tienda de fiesta de cumpleaños en Puebla', 'Globos, velas, decoración y accesorios para cumpleaños.'],
  [300, 'Accesorios de neón para fiestas en Puebla', 'Fiesta neón, flúor y glow: collares, lentes, pulseras y más.'],
  [303, 'Pintura neón en Puebla', 'Pintura fosforescente para cara y cuerpo que brilla con luz negra.'],
  [387, 'Accesorios para la hora loca en Puebla', 'Kits y accesorios luminosos para animar la pista.']
];

const CATEGORIAS = [
  ['273-batucada', 'Batucada'], ['300-sombreros-hule-espuma', 'Sombreros de hule espuma'], ['269-globos', 'Globos'],
  ['284-neon-glow', 'Neón y glow'], ['268-luminosos', 'Luminosos LED'], ['292-sombreros-de-tela', 'Sombreros de tela'],
  ['303-lentes', 'Lentes'], ['276-pelucas', 'Pelucas'], ['287-boda', 'Boda'], ['310-cumpleanos', 'Cumpleaños'],
  ['280-pirotecnia', 'Pirotecnia fría'], ['274-halloween', 'Halloween'], ['271-fiesta-mexicana', 'Fiesta mexicana'], ['290-promociones', 'Promociones']
];

// Los más vendidos de la tienda (ventas reales). Solo nombre y liga: el precio vivo lo carga la página.
const MAS_VENDIDOS = [
  ['/poolparty/83392-collar-hawaiano-neon-4151484124747.html', 'Collar hawaiano neón'],
  ['/neon-glow/83387-corbata-neon-8625559982016.html', 'Corbata neón'],
  ['/neon-glow/83389-bombin-neon-9571834896571.html', 'Bombín neón'],
  ['/batucada/83498-diadema-con-mechudo-2037468317040.html', 'Diadema con mechudo'],
  ['/batucada/83299-diadema-con-pelitos-2037317786948.html', 'Diadema con pelitos'],
  ['/neon-glow/83409-sombrero-vaquero-neon-9571524160938.html', 'Sombrero vaquero neón'],
  ['/batucada/83341-mascara-de-luchador-7748157483695.html', 'Máscara de luchador'],
  ['/batucada/83108-microfono-inflable-8120351839053.html', 'Micrófono inflable']
];

const FAQ = [
  ['¿Dónde está la tienda de Mi Fiesta Shop en Puebla?', `En ${TIENDA.calle}, colonia ${TIENDA.colonia}, C.P. ${TIENDA.cp}, Puebla, Pue. Usa el botón «Cómo llegar» para abrir la ruta en Google Maps.`],
  ['¿Qué venden en la tienda de Puebla?', 'Artículos para fiesta: accesorios para batucada (sombreros de hule espuma, lentes, collares, pelucas, antifaces), luminosos LED y neón, globos, decoración, pirotecnia fría y artículos para bodas, XV años, cumpleaños y fiestas temáticas.'],
  ['¿Venden al mayoreo en Puebla?', 'Sí. Hay precio de mayoreo desde 3 piezas del mismo producto, tanto en la tienda como en la tienda en línea.'],
  ['¿Tienen cosas para batucada en Puebla?', 'Sí, la batucada es nuestra especialidad: sombreros de hule espuma, lentes, collares, mechudos, diademas, antifaces, micrófonos inflables y luminosos para la hora loca de bodas, XV años y fiestas.'],
  ['¿Puedo comprar en línea y recoger en la tienda de Puebla?', 'Sí. Al pagar elige «Recoger en sucursal» y la tienda de Puebla; no pagas envío.'],
  ['¿Hacen envíos dentro de Puebla?', 'Sí. Las entregas en Puebla tardan de 1 a 3 días hábiles y el envío es gratis en compras desde $1,500 MXN.'],
  ['¿Dan factura?', 'Sí. Si tu compra incluyó IVA puedes generar tu factura electrónica (CFDI 4.0) en mifiestashop.com/facturar con tu número de ticket.'],
  ['¿Cuál es el horario y el teléfono de la tienda de Puebla?', `El teléfono de la tienda es ${TIENDA.telefono}. Consulta el horario actualizado en nuestra ficha de Google Maps o pregúntanos por WhatsApp.`]
];

const TITLE = 'Artículos para fiesta en Puebla | Tienda Mi Fiesta Shop';
const DESC = 'Tienda de artículos para fiesta en Puebla (35 Sur 2901): batucada, sombreros de hule espuma, globos, neón, boda y XV años. Mayoreo desde 3 piezas.';
const H1 = 'Tienda de artículos para fiesta en Puebla';
const INTRO = 'Visítanos en la 35 Sur 2901, colonia Santa Cruz Los Ángeles: todo para batucada, hora loca, bodas, XV años y cumpleaños, por pieza o al mayoreo desde 3 piezas.';

function hubSchema(url, pathDe) {
  const tienda = {
    '@type': 'Store', '@id': `${url}#tienda`, name: TIENDA.nombre, url,
    description: 'Tienda de artículos para fiesta y accesorios para batucada en Puebla. Venta por pieza y mayoreo.',
    image: 'https://www.mifiestashop.com/img/cms/logo.webp', logo: 'https://www.mifiestashop.com/img/cms/logo.webp',
    telephone: TIENDA.telefonoE164, priceRange: '$',
    address: { '@type': 'PostalAddress', streetAddress: TIENDA.calle, addressLocality: TIENDA.ciudad, addressRegion: TIENDA.estado, postalCode: TIENDA.cp, addressCountry: 'MX' },
    geo: { '@type': 'GeoCoordinates', latitude: TIENDA.lat, longitude: TIENDA.lng },
    hasMap: TIENDA.mapa,
    areaServed: { '@type': 'City', name: 'Puebla' },
    paymentAccepted: 'Efectivo, tarjeta de crédito, tarjeta de débito, transferencia',
    currenciesAccepted: 'MXN',
    parentOrganization: { '@type': 'Organization', name: 'Mi Fiestashop', url: 'https://www.mifiestashop.com/' },
    knowsAbout: ['Artículos para fiesta', 'Accesorios para batucada', 'Sombreros de hule espuma', 'Accesorios neón', 'Globos', 'Artículos para boda', 'XV años']
  };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      tienda,
      { '@type': 'WebPage', '@id': `${url}#pagina`, url, name: TITLE, description: DESC, about: { '@id': `${url}#tienda` }, inLanguage: 'es-MX' },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Inicio', item: 'https://www.mifiestashop.com/' },
        { '@type': 'ListItem', position: 2, name: 'Tienda en Puebla', item: url }
      ] },
      { '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@type': 'ItemList', name: 'Artículos para fiesta en Puebla', itemListElement: PAGINAS.map(([id], i) => ({ '@type': 'ListItem', position: i + 1, url: 'https://www.mifiestashop.com' + pathDe(id) })) }
    ]
  };
}

function hubSecciones(pathDe) {
  const mapaSrc = `https://www.google.com/maps?q=${TIENDA.lat},${TIENDA.lng}&z=16&output=embed`;
  return `<section class="wrap puebla-hub" id="ubicacion" aria-labelledby="puebla-donde">
<div class="puebla-ficha"><p class="section-kicker">Te esperamos</p><h2 id="puebla-donde">Dónde estamos en Puebla</h2>
<address><strong>${esc(TIENDA.nombre)}</strong><br>${esc(TIENDA.calle)}, col. ${esc(TIENDA.colonia)}<br>C.P. ${TIENDA.cp}, Puebla, Pue.</address>
<p>Teléfono: <a href="tel:${TIENDA.telefonoE164}">${esc(TIENDA.telefono)}</a> · WhatsApp: <a href="${TIENDA.whatsapp}" target="_blank" rel="noopener">56 1262 2146</a></p>
<p>Estamos sobre la 35 Sur, en la zona de Las Ánimas, a unos 3.5 km del zócalo de Puebla.</p>
<div class="hero-actions"><a class="button primary" href="${TIENDA.mapa}" target="_blank" rel="noopener noreferrer">Cómo llegar</a><a class="button secondary" href="tel:${TIENDA.telefonoE164}">Llamar a la tienda</a></div></div>
<iframe class="puebla-mapa" title="Mapa de la tienda Mi Fiesta Shop en Puebla" src="${mapaSrc}" width="600" height="380" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
</section>
<section class="wrap puebla-hub" aria-labelledby="puebla-que">
<h2 id="puebla-que">Qué encuentras en nuestra tienda de Puebla</h2>
<p>Somos especialistas en <strong>artículos para batucada y hora loca</strong>: sombreros de hule espuma, lentes, collares hawaianos, pelucas, antifaces, diademas y accesorios luminosos y de neón. También tenemos globos, velas, decoración, pirotecnia fría y todo para bodas, XV años, cumpleaños, graduaciones, Halloween y fiestas temáticas. Puedes comprar por pieza o al mayoreo desde 3 piezas, ideal para organizadores de eventos, salones de fiesta y revendedores de Puebla.</p>
<div class="puebla-paginas">${PAGINAS.map(([id, t, d]) => `<a class="puebla-card" href="${esc(pathDe(id))}"><strong>${esc(t)}</strong><span>${esc(d)}</span></a>`).join('')}</div>
</section>
<section class="wrap puebla-hub" aria-labelledby="puebla-cats">
<h2 id="puebla-cats">Categorías más buscadas</h2>
<ul class="puebla-chips">${CATEGORIAS.map(([p, n]) => `<li><a href="/${p}">${esc(n)}</a></li>`).join('')}</ul>
<h3>Lo más vendido</h3>
<ul class="puebla-chips">${MAS_VENDIDOS.map(([p, n]) => `<li><a href="${p}">${esc(n)}</a></li>`).join('')}</ul>
</section>
<section class="wrap puebla-hub" aria-labelledby="puebla-como">
<h2 id="puebla-como">Cómo comprar en Puebla</h2>
<ol class="puebla-pasos">
<li><strong>En la tienda:</strong> ven a la 35 Sur 2901 y paga en efectivo, con tarjeta o transferencia.</li>
<li><strong>En línea y recoge en tienda:</strong> haz tu pedido en mifiestashop.com, elige «Recoger en sucursal» y la tienda de Puebla, sin costo de envío.</li>
<li><strong>Envío a domicilio en Puebla:</strong> de 1 a 3 días hábiles; gratis en compras desde $1,500 MXN.</li>
<li><strong>Mayoreo:</strong> el precio de mayoreo aplica desde 3 piezas del mismo producto.</li>
<li><strong>Factura:</strong> si tu compra incluyó IVA, genera tu CFDI en <a href="/facturar">mifiestashop.com/facturar</a>.</li>
</ol>
</section>`;
}

function hubFaq() {
  return `<section class="cms-faq wrap" aria-labelledby="faq-title"><div class="store-section-title"><h2 id="faq-title">Preguntas frecuentes de la tienda en Puebla</h2></div><div class="faq-list">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`;
}

const ESTILOS = `<style>.puebla-hub{margin-block:40px;scroll-margin-top:150px}.puebla-hub .section-kicker{color:#a10060;font-weight:600}.puebla-ficha{padding:28px;border-radius:22px;background:#fdf0f7}.puebla-hub p{max-width:85ch}.puebla-hub h2{margin-bottom:14px}.puebla-hub address{font-style:normal;line-height:1.6;margin:10px 0}
#ubicacion.puebla-hub{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:24px;align-items:center}
.puebla-mapa{width:100%;height:380px;border:0;border-radius:16px}
.puebla-paginas{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-top:18px}
.puebla-card{display:flex;flex-direction:column;gap:6px;padding:16px;border-radius:14px;background:#fff;border:1px solid #f0d6e6;text-decoration:none;color:#2e1065}
.puebla-card span{font-size:.92rem;color:#5b4b6b}.puebla-card:hover{border-color:#d3007b}
.puebla-chips{display:flex;flex-wrap:wrap;gap:10px;list-style:none;padding:0;margin:12px 0 22px}
.puebla-chips a{display:inline-block;padding:8px 14px;border-radius:999px;background:#fdf0f7;color:#a10060;text-decoration:none;font-weight:600}
.puebla-pasos{line-height:1.7;padding-left:20px}
@media (max-width:768px){#ubicacion.puebla-hub{grid-template-columns:1fr}.puebla-mapa{height:280px}}</style>`;

// Toma la página 324 ya armada por build-cms y la convierte en la página principal de la sucursal.
function designPueblaHub(html, model, pathDe) {
  const url = 'https://www.mifiestashop.com' + model.sourcePath;
  const reemplazar = (re, nuevo) => { if (!re.test(html)) throw new Error(`puebla-hub: no encontré ${re}`); html = html.replace(re, nuevo); };
  reemplazar(/<title>[^<]*<\/title>/, `<title>${esc(TITLE)}</title>`);
  reemplazar(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(DESC)}">`);
  reemplazar(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(TITLE)}">`);
  reemplazar(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(DESC)}">`);
  reemplazar(/<script type="application\/ld\+json">[^<]*<\/script>/, () => `<script type="application/ld+json">${JSON.stringify(hubSchema(url, pathDe)).replace(/</g, '\\u003c')}</script>${ESTILOS}`);
  reemplazar(/<h1>[^<]*<\/h1>(<p class="hero-intro">[^<]*<\/p>)?/, `<h1>${esc(H1)}</h1><p class="hero-intro">${esc(INTRO)}</p>`);
  // El bloque genérico "Visítanos en Puebla" se cambia por la ficha completa + secciones del hub.
  reemplazar(/<section class="location-section wrap" id="ubicacion">[\s\S]*?<\/section>/, '');
  reemplazar(/<section class="catalog-section" id="productos">/, () => hubSecciones(pathDe) + '<section class="catalog-section" id="productos">');
  reemplazar(/<section class="cms-faq wrap"[\s\S]*?<\/section>/, () => hubFaq());
  // "Más ideas": solo las páginas de Puebla que se quedan (las otras ya redirigen aquí).
  html = html.replace(/<section class="related-pages wrap">[\s\S]*?<\/section>/, '');
  return html;
}

module.exports = { HUB_ID, CONSOLIDAR, TIENDA, PAGINAS, FAQ, TITLE, DESC, designPueblaHub };
