// Vercel Middleware: reescribe las etiquetas <head> (title, meta
// description, Open Graph, Twitter Card, canonical) directamente en el HTML
// que se manda al navegador, ANTES de que se ejecute nada de JavaScript.
//
// Por qué: este sitio es un SPA de un solo index.html — el <head> real con
// los datos del producto (título, descripción, imagen) solo se rellena vía
// JS después de cargar (applyProductSeoTags() en index.html). Eso funciona
// bien para Google (sí ejecuta JS), pero CUALQUIER bot que no lo haga —
// vista previa de enlaces de WhatsApp/Facebook/Twitter, la mayoría de
// herramientas de auditoría SEO — siempre ve las etiquetas genéricas de la
// portada, sin importar qué producto sea la URL real.
//
// Este middleware intercepta solo las URLs de producto (/{id}-{slug}.html),
// trae nombre/descripción/imagen reales de Supabase (productos_migrados —
// ya migrado, sin tocar PrestaShop) y reescribe esas etiquetas con
// reemplazo de texto sobre el HTML (no HTMLRewriter: este proyecto corre
// el middleware sobre el runtime de Node de Vercel, no el Edge Runtime, y
// esa API no existe ahí — confirmado en vivo). Si el producto no está
// migrado o algo falla, se deja pasar el HTML sin tocar — nunca rompe la
// carga de la página.
export const config = {
  matcher: '/:id(\\d+)-:slug*.html',
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

export default async function middleware(request) {
  if (request.headers.get(BYPASS_HEADER)) return; // ya es la re-petición interna: no reprocesar

  const url = new URL(request.url);
  const match = url.pathname.match(/^\/(\d+)-[^/]+\.html$/);
  if (!match) return; // deja que Vercel sirva la ruta normal, sin tocar nada

  const id = match[1];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/productos_migrados?id=eq.${id}&select=name,description,images`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!r.ok) return;
    const rows = await r.json();
    const p = Array.isArray(rows) && rows[0];
    if (!p || !p.name) return; // producto no migrado todavía: se deja el HTML genérico tal cual

    const bypassHeaders = new Headers(request.headers);
    bypassHeaders.set(BYPASS_HEADER, '1');
    const origin = await fetch(url.toString(), { headers: bypassHeaders });
    if (!origin.ok) return origin;

    const title = `${p.name} | Mi Fiestashop`;
    const desc = (stripHtml(p.description) || `Compra ${p.name} al mayoreo y menudeo en Mi Fiestashop. Envío a todo México.`).slice(0, 160);
    const image = Array.isArray(p.images) && p.images[0] ? p.images[0] : null;
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

    const headers = new Headers(origin.headers);
    // Todas las URLs de producto se reescriben a /index.html (regla de
    // vercel.json), así que la key de caché del borde ignora cuál producto
    // era — sin esto, el borde podría servir las etiquetas de UN producto
    // para la URL de OTRO. Cada URL de producto siempre se recalcula.
    headers.set('Cache-Control', 'no-store, must-revalidate');
    return new Response(html, { status: origin.status, headers });
  } catch (e) {
    return;
  }
}
