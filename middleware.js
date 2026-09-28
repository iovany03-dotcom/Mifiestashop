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
  matcher: ['/:id(\\d+)-:slug*', '/:cat/:id(\\d+)-:slug*'],
};

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// fetch(request) desde dentro del middleware sí vuelve a pasar por este
// mismo middleware en este proyecto (confirmado: Vercel lo detectó y lo
// bloqueó como bucle infinito, error 508). Este header marca la petición
// interna para reconocerla al instante y no reprocesarla.
const BYPASS_HEADER = 'x-mfs-mw-bypass';

function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
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
// Sin "offers"/precio a propósito: el precio vive siempre en vivo en
// PrestaShop (nunca se migró, ver api/productos.js), y traerlo aquí
// añadiría al middleware la misma dependencia lenta que ya nos dejó sin
// catálogo una vez en esta sesión — no vale la pena para un middleware que
// tiene que responder rápido en cada carga de página de producto.
function buildProductJsonLd(name, sku, desc, images) {
  const json = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    sku: sku || undefined,
    description: desc,
    image: images.map(url => ({ '@type': 'ImageObject', url, width: 800, height: 800 }))
  });
  return json.replace(/</g, '\\u003c');
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
  const rows = await sb(`catalogo_productos?id=eq.${id}&select=id,name,sku,link_rewrite,barcode,category_id,active,description_short,description,images,meta_title,meta_description`);
  if (!rows) return { unknown: true };
  const p = rows[0];
  if (!p) return { exists: false };
  const cats = p.category_id ? await sb(`ps_categorias?id=eq.${p.category_id}&select=id,link_rewrite,active`) : [];
  const cat = cats && cats[0];
  if (!p.active) {
    return { redirect: cat && cat.active && cat.link_rewrite ? `/${cat.id}-${cat.link_rewrite}` : CATALOGO_RAIZ };
  }
  const canonicalPath = productoPath(p.id, p.link_rewrite, p.barcode, cat && cat.link_rewrite);
  const migr = await sb(`productos_migrados?id=eq.${id}&select=name,sku,description,images`);
  const m = migr && migr[0];
  const name = (m && m.name) || p.name;
  if (!name) return { exists: true, canonicalPath, seo: null };
  const images = (Array.isArray(p.images) && p.images.length ? p.images : null) || (m && Array.isArray(m.images) ? m.images : []);
  const desc = (stripHtml(p.meta_description) || stripHtml(m && m.description) || stripHtml(p.description_short) || stripHtml(p.description)
    || `Compra ${name} al mayoreo y menudeo en Mi Fiestashop. Envío a todo México.`).slice(0, 160);
  return {
    exists: true,
    canonicalPath,
    seo: {
      title: `${(p.meta_title && p.meta_title.trim()) || name} | Mi Fiestashop`,
      desc,
      image: images[0] || null,
      jsonLd: buildProductJsonLd(name, (m && m.sku) || p.sku, desc, images)
    }
  };
}

// Categoría por id. Las categorías raíz de la instalación compartida
// (1 "Raíz", 2 "inicio") y los ids que ya no existen pero cuyo nombre sí
// (p. ej. /145-promociones -> /290-promociones) se redirigen.
async function resolveCategory(id, slug) {
  if (id === '1' || id === '2') return { redirect: CATALOGO_RAIZ };
  const rows = await sb(`ps_categorias?id=eq.${id}&select=id,name,active,link_rewrite,description,meta_title,meta_description`);
  if (!rows) return { unknown: true };
  const c = rows[0];
  if (!c || !c.name || !c.active) {
    if (slug && /^[a-z0-9-]+$/i.test(slug)) {
      const same = await sb(`ps_categorias?link_rewrite=eq.${encodeURIComponent(slug)}&active=eq.true&select=id,link_rewrite&order=id.desc&limit=1`);
      if (same && same[0]) return { redirect: `/${same[0].id}-${same[0].link_rewrite}` };
    }
    return { exists: false };
  }
  return {
    exists: true,
    canonicalPath: c.link_rewrite ? `/${c.id}-${c.link_rewrite}` : null,
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

export default async function middleware(request) {
  if (request.headers.get(BYPASS_HEADER)) return; // ya es la re-petición interna: no reprocesar

  const url = new URL(request.url);
  // Fotos con la liga vieja de PrestaShop (/{id_imagen}-large_default/x.jpg):
  // no hay forma de saber a qué producto corresponden — 404 real en vez de
  // la portada.
  if (/^\/\d+-[a-z_]+\/[^/]+\.(jpe?g|png|webp|gif)$/i.test(url.pathname)) return notFound(url, request);
  // /{id}-{slug} (categoría), /{id}-{slug}.html y /{categoria}/{id}-{slug}.html
  // (producto, formato de PrestaShop).
  const match = url.pathname.match(/^\/(?:([a-z0-9-]+)\/)?(\d+)-([^/]*?)(\.html)?$/i);
  if (!match) return; // deja que Vercel sirva la ruta normal, sin tocar nada
  const [, catPrefix, id, slug, htmlExt] = match;
  if (catPrefix && !htmlExt) return; // p. ej. /content/329-... (páginas CMS): no es de aquí

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
    if (jsonLd) {
      html = html.replace(/(<script id="ldJsonProduct"[^>]*>)[^<]*(<\/script>)/, `$1${jsonLd}$2`);
    }

    return finalize(html, origin, origin.status);
  } catch (e) {
    return;
  }
}
