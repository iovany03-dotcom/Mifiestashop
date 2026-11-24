// Vercel serverless function: /articulos-para-dj-puebla (vercel.json) — página para DJs, animadores y
// organizadores de eventos en Puebla. Se arma en el servidor con los precios VIVOS del catálogo
// (precio por pieza, precio de mayoreo y desde cuántas piezas aplica), así nunca muestra precios viejos.
// Usa el encabezado, pie y estilos de las páginas CMS (scripts/cms-*.html, includeFiles en vercel.json).
// Se guarda 30 minutos en el CDN.
const fs = require('fs');
const path = require('path');
const { productoPath } = require('../lib/url-producto.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const ORIGEN = 'https://www.mifiestashop.com';
const RUTA = '/articulos-para-dj-puebla';
const HUB = '/content/324-tienda-de-articulos-para-fiesta-puebla';
const WHATSAPP = 'https://wa.me/525612622146?text=' + encodeURIComponent('Hola, soy DJ/animador en Puebla y quiero cotizar un pedido de mayoreo.');

// Lo que más compran DJs y animadores (ventas reales), por grupo.
const GRUPOS = [
  { titulo: 'Luminosos LED', texto: 'Para la hora loca y la pista: se encienden con botón y duran toda la fiesta.', ids: [84529, 84555, 84545, 84530, 84549, 84520, 84537, 84556, 84522, 84561, 84541, 84543, 84534, 84526, 84519, 84528, 84533] },
  { titulo: 'Cyalume (glow)', texto: 'Se activan doblándolos; ideales para repartir en cantidad.', ids: [84516, 84515, 84517, 84518] },
  { titulo: 'Neón para repartir', texto: 'Los clásicos de la batucada que brillan con luz negra.', ids: [83392, 83389, 83387, 83388, 83409, 83419, 83391, 83854, 84590, 83384, 83407] },
  { titulo: 'Efectos', texto: 'Bengalas y serpentina para entradas, vals y cierres.', ids: [83101, 84641, 83303] }
];
const PAQUETES = [10790464092173, 83553, 83547, 83546, 83548];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dinero = n => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function sb(q) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  return r.json();
}

async function datos() {
  const ids = [...new Set(GRUPOS.flatMap(g => g.ids).concat(PAQUETES))];
  const prods = await sb(`catalogo_productos?select=id,name,link_rewrite,barcode,category_id,price,price_mayoreo,price_mayoreo_desde_unidades,images,active&id=in.(${ids.join(',')})`);
  const cats = await sb(`ps_categorias?select=id,link_rewrite&id=in.(${[...new Set(prods.map(p => p.category_id).filter(Boolean))].join(',') || 0})`);
  const catRw = new Map(cats.map(c => [Number(c.id), c.link_rewrite]));
  const porId = new Map(prods.filter(p => p.active && Number(p.price) > 0).map(p => [Number(p.id), {
    ...p, url: productoPath({ id: p.id, linkRewrite: p.link_rewrite, ean13: p.barcode, categoryRewrite: catRw.get(Number(p.category_id)) })
  }]));
  return porId;
}

function mayoreo(p) {
  const m = Number(p.price_mayoreo), d = Number(p.price_mayoreo_desde_unidades);
  return m > 0 && m < Number(p.price) && d > 1 ? { precio: m, desde: d, ahorro: Math.round((1 - m / Number(p.price)) * 100) } : null;
}

function tabla(grupo, porId) {
  const filas = grupo.ids.map(id => porId.get(id)).filter(Boolean);
  if (!filas.length) return '';
  return `<section class="wrap dj-grupo"><h2>${esc(grupo.titulo)}</h2><p>${esc(grupo.texto)}</p>
<div class="dj-tabla-wrap"><table class="dj-tabla"><thead><tr><th>Producto</th><th>Por pieza</th><th>Mayoreo</th><th>Desde</th><th>Ahorras</th></tr></thead><tbody>
${filas.map(p => { const m = mayoreo(p); return `<tr><td><a href="${esc(p.url)}">${esc(p.name)}</a></td><td>${dinero(p.price)}</td><td>${m ? `<b>${dinero(m.precio)}</b><small class="dj-desde">desde ${m.desde} pzas (−${m.ahorro}%)</small>` : '—'}</td><td>${m ? `${m.desde} pzas` : '—'}</td><td>${m ? `${m.ahorro}%` : '—'}</td></tr>`; }).join('\n')}
</tbody></table></div></section>`;
}

const FAQ = [
  ['¿Cómo obtengo el precio de mayoreo?', 'Crea tu cuenta gratis desde el ícono de perfil de la tienda. Al comprar las piezas indicadas del mismo producto (desde 3, 12 o 24 según el artículo), el precio de mayoreo se aplica solo, en línea y en tienda.'],
  ['¿Dónde compro en Puebla?', 'En nuestra tienda de la 35 Sur 2901, col. Santa Cruz Los Ángeles. También puedes pedir en línea y recoger ahí sin costo de envío.'],
  ['¿Hacen envíos?', 'Sí, a todo México. El envío es gratis en compras desde $1,500 MXN; en Puebla llega en 1 a 3 días hábiles.'],
  ['¿Dan factura?', 'Sí. En línea marca "Requiero factura (+16% IVA)" al pagar y después generas tu CFDI en mifiestashop.com/facturar. En tienda pídela en caja.'],
  ['¿Cómo funciona el 10% en la segunda compra?', 'Después de tu primer pedido en línea pagado, escribe el código DJPUEBLA10 en el checkout con el mismo correo. Te da 10% de descuento en los productos (no en el envío) una sola vez.'],
  ['¿Puedo cotizar un pedido grande o recurrente?', 'Sí. Escríbenos por WhatsApp con la lista de productos y cantidades y te confirmamos existencias y fecha de entrega.']
];

function pagina(porId) {
  const raiz = path.join(__dirname, '..');
  const leer = f => fs.readFileSync(path.join(raiz, f), 'utf8');
  const v = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 10);
  const header = leer('scripts/cms-header.html');
  const footer = leer('scripts/cms-footer.html').replace('<!--CMS_LOCATION-->', '<address class="info-line">Puebla: C. 35 Sur 2901, Sta. Cruz Los Ángeles</address>');
  const titulo = 'Artículos para DJs y animadores en Puebla | Precio por volumen';
  const desc = 'Luminosos LED, cyalume, neón y bengalas para DJs y animadores en Puebla con precio de mayoreo desde 3 piezas. Tienda en 35 Sur 2901 y envíos a todo México.';
  const paquetes = PAQUETES.map(id => porId.get(id)).filter(Boolean);
  const todos = GRUPOS.flatMap(g => g.ids).map(id => porId.get(id)).filter(Boolean);
  const schema = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', name: titulo, description: desc, url: ORIGEN + RUTA, inLanguage: 'es-MX', about: { '@id': ORIGEN + HUB + '#tienda' } },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: ORIGEN + '/' },
      { '@type': 'ListItem', position: 2, name: 'Tienda en Puebla', item: ORIGEN + HUB },
      { '@type': 'ListItem', position: 3, name: 'DJs y animadores', item: ORIGEN + RUTA }] },
    { '@type': 'ItemList', name: 'Artículos para DJs con precio por volumen', itemListElement: todos.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: ORIGEN + p.url, name: p.name })) },
    { '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }
  ] };
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGEN}${RUTA}"><meta name="theme-color" content="#d3007b">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${ORIGEN}${RUTA}"><meta property="og:image" content="${ORIGEN}/img/cms/logo.webp">
<link rel="icon" href="/img/icons/icon-32.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/cms.css?v=${v}"><link rel="stylesheet" href="/assets/cms-header.css?v=${v}"><link rel="stylesheet" href="/assets/cms-storefront.css?v=${v}"><link rel="stylesheet" href="/assets/cms-footer.css?v=${v}">
<script defer src="/assets/cms-header.js?v=${v}"></script><script defer src="/assets/cms-pixel.js?v=${v}"></script><script defer src="/assets/cms-whatsapp.js?v=${v}"></script><script defer src="/assets/cms-cart.js?v=${v}"></script>
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
<style>.dj-grupo{margin-block:34px}.dj-grupo>p{color:#5b4b6b;margin:6px 0 12px}
.dj-tabla-wrap{overflow-x:auto;border:1px solid #f0d6e6;border-radius:14px}
.dj-tabla{width:100%;border-collapse:collapse;font-size:14px;min-width:520px}.dj-tabla th{background:#fdf0f7;color:#a10060;text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase}
.dj-tabla td{padding:10px 12px;border-top:1px solid #f6e7f0}.dj-tabla td:nth-child(n+2),.dj-tabla th:nth-child(n+2){text-align:right;white-space:nowrap}.dj-tabla a{color:#2e1065;font-weight:600}
.dj-beneficios{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:16px}.dj-beneficios .dj-cupon{background:#2e1065;color:#fff}.dj-beneficios .dj-cupon b{color:#ffd23f}.dj-beneficios div{background:#fdf0f7;border-radius:14px;padding:16px}.dj-beneficios b{display:block;color:#2e1065;margin-bottom:4px}
.dj-paquetes{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-top:14px}.dj-paquetes a{display:block;padding:16px;border:1px solid #f0d6e6;border-radius:14px;text-decoration:none;color:#2e1065;background:#fff}.dj-paquetes a span{display:block;font-size:1.3rem;font-weight:800;color:#d3007b;margin-top:6px}
.dj-desde{display:none;font-size:11px;color:#6b5b78;font-weight:500}
@media (max-width:600px){.dj-tabla{min-width:0}.dj-tabla th:nth-child(n+4),.dj-tabla td:nth-child(n+4){display:none}.dj-desde{display:block}}
.dj-cta{background:#2e1065;color:#fff;border-radius:22px;padding:28px;margin:40px auto;text-align:center}.dj-cta p{color:#e9ddff;margin:8px auto 16px;max-width:60ch}</style>
</head>
<body data-city="puebla"><a class="skip-link" href="#contenido">Ir al contenido</a>
${header}
<main id="contenido">
<section class="hero hero-text-only"><div class="hero-inner wrap"><div class="hero-copy">
<ul class="topic-tags"><li>DJs</li><li>Animadores</li><li>Organizadores de eventos</li></ul>
<h1>Artículos para DJs y animadores en Puebla</h1>
<p class="hero-intro">Luminosos LED, cyalume, neón y bengalas para la hora loca, con <b>precio de mayoreo desde 3 piezas</b>. Compra en nuestra tienda de la 35 Sur 2901 o pide en línea y recoge sin costo.</p>
<div class="hero-actions"><a class="button primary" href="#precios">Ver precios por volumen</a><a class="button secondary" href="${WHATSAPP}" target="_blank" rel="noopener">Cotizar por WhatsApp</a></div>
</div></div></section>
<section class="wrap"><h2>Beneficios para profesionales</h2><div class="dj-beneficios">
<div><b>Precio de mayoreo automático</b>Con tu cuenta gratis, el precio baja solo al llegar a las piezas indicadas (desde 3, 12 o 24 según el artículo).</div>
<div><b>Envío gratis desde $1,500</b>A todo México; en Puebla de 1 a 3 días hábiles.</div>
<div><b>Recoge en Puebla</b>Pide en línea y recoge en la 35 Sur 2901 sin costo de envío.</div>
<div><b>Factura (CFDI 4.0)</b>Paga con "Requiero factura (+16% IVA)" y genera tu factura en mifiestashop.com/facturar.</div>
<div class="dj-cupon"><b>10% en tu segunda compra</b>Después de tu primer pedido en línea, usa el código <b>DJPUEBLA10</b> al pagar con el mismo correo (una vez por cliente).</div>
<div><b>Pedidos grandes y recurrentes</b>Cotiza por WhatsApp: te confirmamos existencias y fecha de entrega antes de pagar.</div>
</div></section>
<div id="precios">${GRUPOS.map(g => tabla(g, porId)).join('\n')}</div>
${paquetes.length ? `<section class="wrap dj-grupo"><h2>Paquetes listos para la hora loca</h2><p>Kits armados con los artículos más pedidos; conviene cuando necesitas variedad.</p><div class="dj-paquetes">${paquetes.map(p => `<a href="${esc(p.url)}">${esc(p.name)}<span>${dinero(p.price)}</span></a>`).join('')}</div></section>` : ''}
<section class="wrap dj-cta"><h2>¿Tienes evento esta semana?</h2><p>Mándanos tu lista por WhatsApp y te la dejamos lista para recoger en Puebla o te la enviamos.</p><a class="button primary" href="${WHATSAPP}" target="_blank" rel="noopener">Cotizar por WhatsApp</a> <a class="button secondary" href="${HUB}" style="background:#fff">Ver la tienda de Puebla</a></section>
<section class="cms-faq wrap" aria-labelledby="faq-title"><div class="store-section-title"><h2 id="faq-title">Preguntas frecuentes de DJs y animadores</h2></div><div class="faq-list">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>
</main>${footer}</body></html>
`;
}

module.exports = async function handler(req, res) {
  try {
    const html = pagina(await datos());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).send('No se pudo cargar la página. Intenta de nuevo en un momento.');
  }
};
module.exports.datos = datos;
module.exports.pagina = pagina;
module.exports.mayoreo = mayoreo;
