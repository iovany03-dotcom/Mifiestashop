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
  matcher: '/:id(\\d+)-:slug*',
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

// Trae los datos reales (Supabase) para un producto o categoría por id.
// exists=false solo cuando el id de plano no corresponde a nada real (ni
// producto ni categoría) — ahí el llamador manda un 404 real en vez del
// típico 200 "soft 404" de un SPA, que Google penaliza como señal de baja
// calidad. exists=true con seo=null significa "es real pero sin datos
// todavía" (producto no migrado, o falló Supabase) — eso SIGUE como 200
// con el HTML genérico, nunca se inventa un 404 por un error transitorio.
async function fetchProduct(id) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/productos_migrados?id=eq.${id}&select=name,sku,description,images`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (r.ok) {
    const rows = await r.json();
    const p = Array.isArray(rows) && rows[0];
    if (p && p.name) {
      const desc = (stripHtml(p.description) || `Compra ${p.name} al mayoreo y menudeo en Mi Fiestashop. Envío a todo México.`).slice(0, 160);
      const images = Array.isArray(p.images) ? p.images : [];
      return {
        exists: true,
        seo: {
          title: `${p.name} | Mi Fiestashop`,
          desc,
          image: images[0] || null,
          jsonLd: buildProductJsonLd(p.name, p.sku, desc, images)
        }
      };
    }
  }
  // No migrado todavía (o Supabase falló) — antes de decidir 404, se
  // revisa ps_stock: cubre TODO el catálogo real (migrado o no, ~82,000
  // filas sincronizadas de PrestaShop), así que un id ausente ahí también
  // sí es un id que de verdad no existe.
  try {
    const r2 = await fetch(
      `${SUPABASE_URL}/rest/v1/ps_stock?id_product=eq.${id}&select=id_product&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (r2.ok) {
      const rows2 = await r2.json();
      if (Array.isArray(rows2) && rows2.length > 0) return { exists: true, seo: null };
      return { exists: false, seo: null };
    }
  } catch (e) { /* fetch falló: no se afirma que no existe, ver abajo */ }
  // No se pudo confirmar ni una cosa ni la otra (error de red/Supabase) —
  // se asume que existe para no arriesgar un 404 falso por una falla
  // transitoria nuestra.
  return { exists: true, seo: null };
}

async function fetchCategory(id) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/ps_categorias?id=eq.${id}&select=name,active,description,meta_title,meta_description`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!r.ok) return { exists: true, seo: null }; // falla nuestra: no se afirma que no existe
  const rows = await r.json();
  const c = Array.isArray(rows) && rows[0];
  // ps_categorias sincroniza TODAS las categorías reales de PrestaShop cada
  // hora — si el id no aparece aquí, de verdad no existe. Inactiva cuenta
  // igual como "no existe" (no debe indexarse ni mostrar datos reales).
  if (!c || !c.name || !c.active) return { exists: false, seo: null };
  // meta_title/meta_description casi nunca están capturados a mano para
  // categorías en PrestaShop (a diferencia de productos) — se cae a un
  // texto genérico pero real (con el nombre de la categoría), nunca al
  // título/descripción de la portada.
  return {
    exists: true,
    seo: {
      title: `${(c.meta_title && c.meta_title.trim()) || c.name} | Mi Fiestashop`,
      desc: (stripHtml(c.meta_description) || stripHtml(c.description) || `Compra ${c.name} al mayoreo y menudeo en Mi Fiestashop. Envío a todo México.`).slice(0, 160),
      image: null,
      jsonLd: null
    }
  };
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
  const match = url.pathname.match(/^\/(\d+)-[^/]+?(\.html)?$/);
  if (!match) return; // deja que Vercel sirva la ruta normal, sin tocar nada

  const id = match[1];
  const isProduct = !!match[2];
  try {
    const { exists, seo } = isProduct ? await fetchProduct(id) : await fetchCategory(id);

    const bypassHeaders = new Headers(request.headers);
    bypassHeaders.set(BYPASS_HEADER, '1');
    const origin = await fetch(url.toString(), { headers: bypassHeaders });
    if (!origin.ok) return origin;

    if (!exists) {
      // Id que de plano no corresponde a nada real: 404 real en vez del
      // 200 "soft 404" típico de un SPA — el HTML sigue siendo el mismo
      // (la SPA ya sabe mostrar "no encontrado"), solo cambia el status.
      return finalize(await origin.text(), origin, 404);
    }
    if (!seo) return; // existe pero sin datos todavía (no migrado / error transitorio): HTML genérico tal cual, 200

    const { title, desc, image, jsonLd } = seo;
    const pageUrl = url.toString();

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
