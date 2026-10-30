// Vercel Middleware: reescribe las etiquetas <head> (title, meta
// description, Open Graph, Twitter Card, canonical) directamente en el HTML
// que se manda al navegador, ANTES de que se ejecute nada de JavaScript.
//
// Por qué: este sitio es un SPA de un solo index.html — el <head> real con
// los datos del producto/categoría (título, descripción, imagen) solo se
// rellena vía JS después de cargar. Eso funciona bien para Google (sí
// ejecuta JS), pero CUALQUIER bot que no lo haga — vista previa de enlaces
// de WhatsApp/Facebook/Twitter, la mayoría de herramientas de auditoría
// SEO — siempre ve las etiquetas genéricas de la portada, sin importar qué
// producto o categoría sea la URL real.
//
// Este middleware intercepta las URLs de producto (/{id}-{slug}.html, con
// datos de Supabase productos_migrados) y de categoría (/{id}-{slug}, sin
// .html, con datos de Supabase ps_categorias) y reescribe esas etiquetas
// con reemplazo de texto sobre el HTML (no HTMLRewriter: este proyecto
// corre el middleware sobre el runtime de Node de Vercel, no el Edge
// Runtime, y esa API no existe ahí — confirmado en vivo). Si el producto
// no está migrado, la categoría no existe, o algo falla, se deja pasar el
// HTML sin tocar — nunca rompe la carga de la página.
export const config = {
  matcher: ['/', '/:id(\\d+)-:slug*', '/:cat/:id(\\d+)-:slug*'],
};

import cmsManifest from './data/cms-manifest.json';

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// fetch(request) desde dentro del middleware sí vuelve a pasar por este
// mismo middleware en este proyecto (confirmado: Vercel lo detectó y lo
// bloqueó como bucle infinito, error 508). Este header marca la petición
// interna para reconocerla al instante y no reprocesarla.
const BYPASS_HEADER = 'x-mfs-mw-bypass';

function stripHtml(str) {
  return String(str || '').replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function escapeAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Reemplaza el contenido de una etiqueta por id, ej.
// <title id="pageTitleTag">...</title> -> nuevo texto entre las etiquetas.
function replaceTagText(html, id, tagName, newText) {
  const re = new RegExp(`(<${tagName}[^>]*id="${id}"[^>]*>)[^<]*(</${tagName}>)`);
  return html.replace(re, `$1${escapeAttr(newText)}$2`);
}

// Reemplaza el valor de un atributo (content/href) dentro de una etiqueta
// identificada por un selector simple (id="..." o property="..."/name="...").
function replaceAttr(html, selector, attr, newValue) {
  const re = new RegExp(`(<[a-z]+[^>]*${selector}[^>]*${attr}=")[^"]*(")`);
  return html.replace(re, `$1${escapeAttr(newValue)}$2`);
}

// Arma el JSON-LD Product (Schema.org) como texto seguro para incrustar en
// un <script>: escapa "<" para que ni una descripción con ese caracter
// pueda cerrar la etiqueta antes de tiempo (</script> dentro del string).
// El precio sale de catalogo_productos (la fuente desde que se desconectó PrestaShop), en la
// misma consulta: no agrega llamadas. Con "offers" Google puede mostrar el precio en los
// resultados; BreadcrumbList muestra Inicio › Categoría en vez de la URL.
function buildProductJsonLd(name, sku, desc, images, extra = {}) {
  const { price, pageUrl, barcode, categoria } = extra;
  const producto = {
    '@type': 'Product',
    name,
    sku: sku || undefined,
    gtin13: gtin13Valido(barcode) ? String(barcode) : undefined,
    brand: { '@type': 'Brand', name: 'Mi Fiestashop' },
    description: desc,
    image: images.map(url => ({ '@type': 'ImageObject', url, width: 800, height: 800 }))
  };
  if (Number(price) > 0) {
    producto.offers = {
      '@type': 'Offer', price: Number(price).toFixed(2), priceCurrency: 'MXN',
      availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition',
      url: pageUrl || undefined, seller: { '@type': 'Organization', name: 'Mi Fiestashop' }
    };
  }
  const migas = [{ '@type': 'ListItem', position: 1, name: 'Inicio', item: `${ORIGEN_SEO}/` }];
  if (categoria && categoria.name && categoria.path) migas.push({ '@type': 'ListItem', position: 2, name: categoria.name, item: `${ORIGEN_SEO}${categoria.path}` });
  migas.push({ '@type': 'ListItem', position: migas.length + 1, name, item: pageUrl || undefined });
  const json = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [producto, { '@type': 'BreadcrumbList', itemListElement: migas }]
  });
  return json.replace(/</g, '\\u003c');
}
const ORIGEN_SEO = 'https://www.mifiestashop.com';
// Solo se declara el GTIN si el dígito verificador cuadra: muchos códigos de barras del
// catálogo son internos y un GTIN inválido es un error en Google Merchant / resultados.
function gtin13Valido(c) {
  const s = String(c || '');
  if (!/^\d{13}$/.test(s)) return false;
  const suma = s.slice(0, 12).split('').reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === Number(s[12]);
}

// Consulta a Supabase con la llave pública. null = falla nuestra (red o
// Supabase): en ese caso nunca se inventa un 404 ni una redirección.
async function sb(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) { return null; }
}

// Misma liga que PrestaShop (ver lib/url-producto.js):
// /{categoria}/{id}-{link_rewrite}-{ean13}.html
function productoPath(id, linkRewrite, ean13, categoryRewrite) {
  if (!id || !linkRewrite) return '';
  const ean = String(ean13 || '').trim();
  return `${categoryRewrite ? '/' + categoryRewrite : ''}/${id}-${linkRewrite}${ean ? '-' + ean : ''}.html`;
}

const CATALOGO_RAIZ = '/266-productos';

// Producto por id (catalogo_productos: todo el catálogo de la tienda 50,
// activo o no). Devuelve { unknown } si no se pudo consultar, { exists:
// false } si el id no es de la tienda, { redirect } si está desactivado
// (a su categoría, como hace PrestaShop) o { canonicalPath, seo }.
async function resolveProduct(id) {
  const rows = await sb(`catalogo_productos?id=eq.${id}&select=id,name,sku,link_rewrite,barcode,category_id,active,description_short,description,images,meta_title,meta_description,price,price_mayoreo,price_mayoreo_desde_unidades`);
  if (!rows) return { unknown: true };
  const p = rows[0];
  if (!p) return { exists: false };
  const cats = p.category_id ? await sb(`ps_categorias?id=eq.${p.category_id}&select=id,name,link_rewrite,active`) : [];
  const cat = cats && cats[0];
  if (!p.active) {
    return { redirect: cat && cat.active && cat.link_rewrite ? `/${cat.id}-${cat.link_rewrite}` : CATALOGO_RAIZ };
  }
  const canonicalPath = productoPath(p.id, p.link_rewrite, p.barcode, cat && cat.link_rewrite);
  const migr = await sb(`productos_migrados?id=eq.${id}&select=name,sku,description,images`);
  const m = migr && migr[0];
  const name = (m && m.name) || p.name;
  if (!name) return { exists: true, canonicalPath, seo: null };
  // Igual que lib/productos-supabase.js: la lista con más fotos gana.
  const catImgs = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  const migImgs = m && Array.isArray(m.images) ? m.images.filter(Boolean) : [];
  const images = migImgs.length > catImgs.length ? migImgs : catImgs;
  const desc = (stripHtml(p.meta_description) || stripHtml(m && m.description) || stripHtml(p.description_short) || stripHtml(p.description)
    || `Compra ${name} al mayoreo y menudeo en Mi Fiestashop. Envío a todo México.`).slice(0, 160);
  return {
    exists: true,
    canonicalPath,
    seo: {
      title: `${(p.meta_title && p.meta_title.trim()) || name} | Mi Fiestashop`,
      desc,
      image: images[0] || null,
      ssr: {
        tipo: 'producto', name, price: Number(p.price) || 0, images,
        mayoreo: Number(p.price_mayoreo) > 0 && Number(p.price_mayoreo) < Number(p.price) && p.price_mayoreo_desde_unidades > 1 ? { precio: Number(p.price_mayoreo), desde: p.price_mayoreo_desde_unidades } : null,
        descripcion: (m && m.description) || p.description || p.description_short || '',
        categoria: cat && cat.active && cat.link_rewrite ? { name: cat.name, path: `/${cat.id}-${cat.link_rewrite}` } : null
      },
      jsonLd: buildProductJsonLd(name, (m && m.sku) || p.sku, desc, images, {
        price: p.price, barcode: p.barcode, pageUrl: `${ORIGEN_SEO}${canonicalPath}`,
        categoria: cat && cat.active && cat.link_rewrite ? { name: cat.name, path: `/${cat.id}-${cat.link_rewrite}` } : null
      })
    }
  };
}

// Categoría por id. Las categorías raíz de la instalación compartida
// (1 "Raíz", 2 "inicio") y los ids que ya no existen pero cuyo nombre sí
// (p. ej. /145-promociones -> /290-promociones) se redirigen.
async function resolveCategory(id, slug) {
  if (id === '1' || id === '2') return { redirect: CATALOGO_RAIZ };
  const rows = await sb(`ps_categorias?id=eq.${id}&select=id,name,active,link_rewrite,description,meta_title,meta_description,faq`);
  if (!rows) return { unknown: true };
  const c = rows[0];
  if (!c || !c.name || !c.active) {
    if (slug && /^[a-z0-9-]+$/i.test(slug)) {
      const same = await sb(`ps_categorias?link_rewrite=eq.${encodeURIComponent(slug)}&active=eq.true&select=id,link_rewrite&order=id.desc&limit=1`);
      if (same && same[0]) return { redirect: `/${same[0].id}-${same[0].link_rewrite}` };
    }
    return { exists: false };
  }
  // Productos de la categoría (para la lista en el HTML y el ItemList de Google).
  const prods = await sb(`catalogo_productos?category_id=eq.${c.id}&active=eq.true&select=id,name,price,link_rewrite,barcode&order=id.desc&limit=60`) || [];
  const ssr = {
    tipo: 'categoria', id: c.id, name: c.name, descripcion: c.description || '',
    faq: (Array.isArray(c.faq) ? c.faq : []).filter(x => x && x.pregunta && x.respuesta).slice(0, 10),
    productos: prods.filter(x => x.name && x.link_rewrite).map(x => ({ name: x.name, price: Number(x.price) || 0, path: productoPath(x.id, x.link_rewrite, x.barcode, c.link_rewrite) }))
  };
  return {
    exists: true,
    canonicalPath: c.link_rewrite ? `/${c.id}-${c.link_rewrite}` : null,
    ssr,
    seo: {
      title: `${(c.meta_title && c.meta_title.trim()) || c.name} | Mi Fiestashop`,
      desc: (stripHtml(c.meta_description) || stripHtml(c.description) || `Compra ${c.name} al mayoreo y menudeo en Mi Fiestashop. Envío a todo México.`).slice(0, 160),
      image: null,
      jsonLd: null
    }
  };
}

function redirectTo(url, path) {
  return new Response(null, { status: 301, headers: { Location: new URL(path + url.search, url).toString(), 'Cache-Control': 'public, max-age=3600' } });
}

// Página 404 propia (404.html) con status 404 real.
async function notFound(url, request) {
  const headers = new Headers(request.headers);
  headers.set(BYPASS_HEADER, '1');
  const page = await fetch(new URL('/404.html', url).toString(), { headers });
  const html = await page.text();
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Arma la Response final a partir del HTML de origen: limpia los headers
// que causaron la carga infinita la primera vez que se hizo este
// middleware (Content-Length/Content-Encoding heredados ya no aplican una
// vez que el HTML se reescribió) y fuerza no-store para que el borde nunca
// sirva las etiquetas de UNA página en la URL de OTRA.
function finalize(html, origin, status) {
  const headers = new Headers(origin.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('Cache-Control', 'no-store, must-revalidate');
  return new Response(html, { status, headers });
}

function isPrestashopFacetQuery(params) {
  if (params.has('SubmitCurrency') || params.has('id_currency')) return true;
  if (/^product\./.test(params.get('order') || '')) return true;
  return /^Categor[ií]as-/i.test(params.get('q') || '');
}

function goneFacet(url) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Página no disponible | Mi Fiestashop</title></head>` +
    `<body style="font-family:sans-serif;text-align:center;padding:40px;"><p>Esta liga de filtros ya no existe.</p><p><a href="${escapeAttr(url.pathname)}">Ver los productos</a></p></body></html>`;
  return new Response(html, {
    status: 410,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'public, max-age=86400' }
  });
}


// ---------------------------------------------------------------- tienda ligera
// index.html trae la tienda Y todo el panel de administración (1.2 MB). El panel se sirve aparte
// en /admin (api/admin-page.js, el index.html completo), así que a las páginas de la tienda se les
// quita el marcado del panel y sus ventanas, y el código (un solo <script> de ~800 KB) se manda como
// archivo aparte /app/<hash>.js (api/app-js.js) que el navegador guarda en caché: cada página pesa
// ~170 KB y Google lee solo la tienda. El hash cambia con cada versión del código.
const MODALES_ADMIN = ['apiKeyModal', 'editProductModal', 'orderDetailModal', 'crearPedidoModal', 'checkoutModal', 'ticketModal',
  'ticketHistorialModal', 'salidasCajaModal', 'abrirCajaModal', 'cerrarCajaModal', 'ticketConfigModal', 'cajaHistorialModal',
  'salidaFotoModal', 'personalModal', 'cmsPageAdminModal', 'promoAdminModal', 'emailTemplatePreviewModal', 'prodModalOverlay',
  'recModal', 'traspasoModal', 'movHistoryModal',
  // Acceso al panel: solo se abre en /admin, que recibe el HTML completo (api/admin-page.js).
  'loginModal'];

// Quita el elemento con ese id (y todo su contenido) contando etiquetas abiertas/cerradas.
function quitarElemento(html, id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return html;
  const ini = html.lastIndexOf('<', i);
  const tag = (/^<([a-zA-Z0-9]+)/.exec(html.slice(ini)) || [])[1];
  if (!tag) return html;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = ini;
  let prof = 0, m;
  while ((m = re.exec(html))) {
    prof += m[1] ? -1 : 1;
    if (prof === 0) return html.slice(0, ini) + html.slice(m.index + m[0].length);
  }
  return html;
}

let appCache = { clave: null, hash: null };
async function hashTexto(t) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

async function tiendaLigera(html) {
  // El script grande: el único <script> sin atributos de más de 100 KB.
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m, grande = null;
  while ((m = re.exec(html))) if (m[1].length > 100000) { grande = m; break; }
  if (!grande) return html; // estructura inesperada: no se toca nada
  const clave = `${grande[1].length}:${grande[1].slice(0, 200)}:${grande[1].slice(-200)}`;
  if (appCache.clave !== clave) appCache = { clave, hash: await hashTexto(grande[1]) };
  let h = html.slice(0, grande.index) + `<script src="/app/${appCache.hash}.js"></script>` + html.slice(grande.index + grande[0].length);
  h = quitarElemento(h, 'adminDashboardWrapper');
  for (const id of MODALES_ADMIN) h = quitarElemento(h, id);
  return h;
}

// Un solo H1 por página: el de la página. Los demás títulos fijos de la tienda bajan a H2/p.
// tipo: 'inicio' (se queda el H1 de la portada), 'producto' (el H1 es el nombre) o 'categoria'
// (el H1 es el título del catálogo).
// Rango [inicio, fin) del elemento con ese id (mismo conteo de etiquetas que quitarElemento).
function rangoElemento(html, id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return null;
  const ini = html.lastIndexOf('<', i);
  const tag = (/^<([a-zA-Z0-9]+)/.exec(html.slice(ini)) || [])[1];
  if (!tag) return null;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = ini;
  let prof = 0, m;
  while ((m = re.exec(html))) { prof += m[1] ? -1 : 1; if (prof === 0) return [ini, m.index + m[0].length]; }
  return null;
}

// Producto y categoría: los <h2> fuera de los bloques propios de la página pasan a
// <div role="heading" class="t2"> (se ven igual, ver .t2 en index.html) para que Google no tome
// "Productos Destacados", "Nuestras Sucursales", "Contacto"… como subtítulos de cada producto.
function soloH2Propios(html, conservar) {
  const rangos = conservar.map(id => rangoElemento(html, id)).filter(Boolean);
  return html.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (todo, attrs, dentro, pos) => {
    if (rangos.some(([a, b]) => pos >= a && pos < b)) return todo;
    const a = /\bclass\s*=\s*"/i.test(attrs) ? attrs.replace(/\bclass\s*=\s*"/i, 'class="t2 ') : `${attrs} class="t2"`;
    return `<div role="heading" aria-level="2"${a}>${dentro}</div>`;
  });
}

function unSoloH1(html, tipo) {
  if (tipo !== 'inicio') html = html.replace('<h1 class="sr-only">', '<p class="sr-only">').replace(/(<p class="sr-only">[^<]*)<\/h1>/, '$1</p>');
  if (tipo !== 'categoria') html = html.replace('<h1 id="catalogSearchTitle" class="catalog-search-title hidden"></h1>', '<h2 id="catalogSearchTitle" class="catalog-search-title hidden"></h2>');
  return html
    .replace('<h1 style="color:#2e1065; margin-bottom:8px;">Contacto</h1>', '<h2 style="color:#2e1065; margin-bottom:8px; font-size:2em;">Contacto</h2>')
    .replace(/<h1 id="cmsPageHeroTitle"([^>]*)><\/h1>/, '<h2 id="cmsPageHeroTitle"$1></h2>');
}

function htmlSeguro(h) {
  return String(h || '')
    .replace(/<\s*(script|style|iframe|object|embed|form)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|form|input|button)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}
const dinero = n => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Ficha del producto ya armada en el HTML (Google y el cliente la ven sin esperar al JavaScript;
// la tienda la vuelve a dibujar igual, con existencias y botón de compra, al cargar).
function fichaProducto(ssr) {
  const migas = `<nav class="ssr-migas" aria-label="Migas de pan" style="font-size:13px; margin:0 0 12px;"><a href="/">Inicio</a>${ssr.categoria ? ` › <a href="${escapeAttr(ssr.categoria.path)}">${escapeAttr(ssr.categoria.name)}</a>` : ''} › <span>${escapeAttr(ssr.name)}</span></nav>`;
  const fotos = ssr.images.slice(0, 4).map((u, i) => `<img src="${escapeAttr(u)}" alt="${escapeAttr(ssr.name)}${i ? ` — foto ${i + 1}` : ''}" width="${i ? 120 : 480}" height="${i ? 120 : 480}" style="max-width:100%; height:auto; border-radius:12px; object-fit:cover;"${i ? ' loading="lazy"' : ' fetchpriority="high"'}>`).join(' ');
  return `${migas}<article class="ssr-producto"><h1 style="font-size:1.6rem; margin:0 0 10px;">${escapeAttr(ssr.name)}</h1>
<div>${fotos}</div>
${ssr.price > 0 ? `<p style="font-size:1.5rem; font-weight:800; color:#2e1065; margin:12px 0 4px;">${dinero(ssr.price)} MXN</p>` : ''}
${ssr.mayoreo ? `<p style="margin:0 0 10px;">Mayoreo: ${dinero(ssr.mayoreo.precio)} c/u desde ${ssr.mayoreo.desde} piezas</p>` : ''}
<div class="ssr-descripcion">${htmlSeguro(ssr.descripcion)}</div></article>`;
}

function introCategoria(ssr) {
  const lista = ssr.productos.length ? `<ul class="ssr-lista" style="columns:2; font-size:13px; padding-left:18px;">${ssr.productos.map(p => `<li><a href="${escapeAttr(p.path)}">${escapeAttr(p.name)}</a>${p.price > 0 ? ` — ${dinero(p.price)}` : ''}</li>`).join('')}</ul>` : '';
  return `<div class="ssr-categoria-productos">${lista}</div>`;
}

// Igual que faqCategoriaHtml en index.html (la tienda la vuelve a dibujar igual al cargar).
function faqCategoria(ssr) {
  if (!ssr.faq.length) return '';
  return `<h2>Preguntas frecuentes sobre ${escapeAttr(ssr.name)}</h2>` + ssr.faq.map(x => `<details><summary>${escapeAttr(x.pregunta)}</summary><p>${escapeAttr(x.respuesta)}</p></details>`).join('');
}

function catalogoProductosJsonLd(ssr, pageUrl) {
  const json = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: ssr.name, url: pageUrl, description: stripHtml(ssr.descripcion).slice(0, 300) || undefined,
        mainEntity: { '@type': 'ItemList', numberOfItems: ssr.productos.length, itemListElement: ssr.productos.slice(0, 30).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${ORIGEN_SEO}${p.path}`, name: p.name })) } },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${ORIGEN_SEO}/` },
        { '@type': 'ListItem', position: 2, name: ssr.name, item: pageUrl }] },
      ...(ssr.faq.length ? [{ '@type': 'FAQPage', mainEntity: ssr.faq.map(x => ({ '@type': 'Question', name: x.pregunta, acceptedAnswer: { '@type': 'Answer', text: x.respuesta } })) }] : [])
    ]
  });
  return json.replace(/</g, '\\u003c');
}

async function servirInicio(url, request) {
  const bypassHeaders = new Headers(request.headers);
  bypassHeaders.set(BYPASS_HEADER, '1');
  const origin = await fetch(url.toString(), { headers: bypassHeaders });
  if (!origin.ok || !(origin.headers.get('content-type') || '').includes('text/html')) return origin;
  const html = unSoloH1(await tiendaLigera(await origin.text()), 'inicio');
  const headers = new Headers(origin.headers);
  headers.delete('content-length'); headers.delete('content-encoding');
  headers.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
  return new Response(html, { status: 200, headers });
}

export default async function middleware(request) {
  if (request.headers.get(BYPASS_HEADER)) return; // ya es la re-petición interna: no reprocesar

  const url = new URL(request.url);
  // Filtros viejos de PrestaShop (?SubmitCurrency=1&id_currency=2&order=
  // product.name.desc&q=Categorías-Globos-Velas...): desde el 28 de sep.
  // 2026 un robot con miles de IPs (proxies residenciales de todo el
  // mundo) recorre todas las combinaciones sobre /266-productos, ~1,000
  // cargas por minuto. El sitio nuevo no usa esos parámetros: se contesta
  // 410 al instante, sin consultar Supabase ni cargar la tienda (y le dice
  // a Google que esas ligas ya no existen).
  if (isPrestashopFacetQuery(url.searchParams)) return goneFacet(url);
  if (url.pathname === '/') {
    try { return await servirInicio(url, request); } catch (e) { return; }
  }
  // Fotos con la liga vieja de PrestaShop (/{id_imagen}-large_default/x.jpg):
  // no hay forma de saber a qué producto corresponden — 404 real en vez de
  // la portada.
  if (/^\/\d+-[a-z_]+\/[^/]+\.(jpe?g|png|webp|gif)$/i.test(url.pathname)) return notFound(url, request);
  // /{id}-{slug} (categoría), /{id}-{slug}.html y /{categoria}/{id}-{slug}.html
  // (producto, formato de PrestaShop).
  const match = url.pathname.match(/^\/(?:([a-z0-9-]+)\/)?(\d+)-([^/]*?)(\.html)?$/i);
  if (!match) return; // deja que Vercel sirva la ruta normal, sin tocar nada
  const [, catPrefix, id, slug, htmlExt] = match;
  if (catPrefix && !htmlExt) {
    // Páginas CMS (/content/<id>-<slug>). Con un id que no existe y un slug que sí, se manda (301)
    // a la primera página con ese slug, como hacía PrestaShop. Se resuelve aquí porque la regla
    // de reescritura de vercel.json daba 502 ROUTER_CANNOT_MATCH en esos casos.
    if (catPrefix.toLowerCase() === 'content') {
      try {
        const path = decodeURIComponent(url.pathname);
        const exactos = new Set(cmsManifest.map(p => p.path).concat(['/content/417-articulos-para-fiesta-mayoreo-en-mexico', '/content/418-contactanos']));
        if (!exactos.has(path)) {
          const cms = cmsManifest.filter(p => p.slug === slug).sort((a, b) => a.id - b.id)[0];
          if (cms) return redirectTo(url, cms.path);
        }
      } catch (e) { /* si algo falla, sigue el flujo normal */ }
    }
    return; // lo demás de /content/...: no es de aquí
  }

  const isProduct = !!htmlExt;
  try {
    const r = isProduct ? await resolveProduct(id) : await resolveCategory(id, slug);
    if (r.unknown) return; // no se pudo consultar: HTML genérico tal cual, 200
    if (r.redirect) return redirectTo(url, r.redirect);
    if (!r.exists) return notFound(url, request);
    // Cualquier otra variante de la liga (otro slug, sin categoría, la liga
    // corta que usaba este sitio, una combinación) -> 301 a la liga
    // canónica de PrestaShop, que es la que Google tiene indexada.
    if (r.canonicalPath && decodeURIComponent(url.pathname) !== r.canonicalPath) return redirectTo(url, r.canonicalPath);
    if (!r.seo) return;

    const bypassHeaders = new Headers(request.headers);
    bypassHeaders.set(BYPASS_HEADER, '1');
    const origin = await fetch(url.toString(), { headers: bypassHeaders });
    if (!origin.ok) return origin;

    const { title, desc, image, jsonLd } = r.seo;
    const pageUrl = `${url.origin}${r.canonicalPath || url.pathname}`;

    let html = await origin.text();
    html = replaceTagText(html, 'pageTitleTag', 'title', title);
    html = replaceAttr(html, 'id="metaDescription"', 'content', desc);
    html = replaceAttr(html, 'id="canonicalLink"', 'href', pageUrl);
    html = replaceAttr(html, 'id="ogTitle"', 'content', title);
    html = replaceAttr(html, 'id="ogDescription"', 'content', desc);
    html = replaceAttr(html, 'id="ogUrl"', 'content', pageUrl);
    html = replaceAttr(html, 'id="twitterTitle"', 'content', title);
    html = replaceAttr(html, 'id="twitterDescription"', 'content', desc);
    if (image) {
      html = replaceAttr(html, 'property="og:image"', 'content', image);
      html = replaceAttr(html, 'name="twitter:image"', 'content', image);
    }
    const ssr = r.ssr || (r.seo && r.seo.ssr) || null;
    const ld = jsonLd || (ssr && ssr.tipo === 'categoria' ? catalogoProductosJsonLd(ssr, pageUrl) : null);
    if (ld) {
      html = html.replace(/(<script id="ldJsonProduct"[^>]*>)[^<]*(<\/script>)/, `$1${ld}$2`);
    }

    // Tienda ligera + contenido ya armado en el HTML.
    try {
      html = unSoloH1(await tiendaLigera(html), ssr && ssr.tipo === 'categoria' ? 'categoria' : 'producto');
      if (ssr && ssr.tipo === 'producto') {
        html = html
          .replace('<div class="store-hero" id="storefrontHero"', '<div class="store-hero hidden" id="storefrontHero"')
          .replace('<div id="storefrontStoreContainer">', '<div id="storefrontStoreContainer" class="hidden">')
          .replace('class="store-container hidden" id="storefrontProductPage"', 'class="store-container" id="storefrontProductPage"')
          .replace('<div id="storefrontProductPageBody"></div>', `<div id="storefrontProductPageBody">${fichaProducto(ssr)}</div>`);
      } else if (ssr && ssr.tipo === 'categoria') {
        html = html
          .replace('<div class="store-hero" id="storefrontHero"', '<div class="store-hero hidden" id="storefrontHero"')
          .replace('<div id="storefrontStoreContainer">', '<div id="storefrontStoreContainer" class="hidden">')
          .replace('class="store-container hidden" id="storefrontCatalogPage"', 'class="store-container" id="storefrontCatalogPage"')
          .replace('<h1 id="catalogSearchTitle" class="catalog-search-title hidden"></h1>', `<h1 id="catalogSearchTitle" class="catalog-search-title">${escapeAttr(ssr.name)}</h1><div id="catalogCatIntro" class="catalog-cat-intro">${htmlSeguro(ssr.descripcion)}</div>`)
          .replace('<div class="store-prods-grid" id="catalogGrid"></div>', `<div class="store-prods-grid" id="catalogGrid">${introCategoria(ssr)}</div>`)
          .replace('<section id="catalogCatFaq" class="catalog-cat-faq hidden"></section>', `<section id="catalogCatFaq" class="catalog-cat-faq${ssr.faq.length ? '' : ' hidden'}">${faqCategoria(ssr)}</section>`);
      }
      // Los H2 de las secciones del inicio, contacto, etc. (ocultas aquí) no son de esta página.
      if (ssr) html = soloH2Propios(html, ['catalogCatIntro', 'catalogCatFaq']);
      // El banner del inicio no se ve aquí: no se precarga (en celular gasta datos y retrasa la foto del producto).
      if (ssr) html = html.replace('<link rel="preload" as="image" href="/img/hero-banner.webp" fetchpriority="high">', '');
    } catch (e) { /* si algo falla se manda el HTML con las etiquetas ya puestas */ }

    return finalize(html, origin, origin.status);
  } catch (e) {
    return;
  }
}
