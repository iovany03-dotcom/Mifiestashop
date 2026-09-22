// Vercel Edge Middleware: reescribe las etiquetas <head> (title, meta
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
// ya migrado, sin tocar PrestaShop) y reescribe esas etiquetas al vuelo con
// HTMLRewriter (streaming, no carga el HTML completo en memoria). Si el
// producto no está migrado o algo falla, se deja pasar el HTML sin tocar —
// nunca rompe la carga de la página.
export const config = {
  matcher: '/:id(\\d+)-:slug*.html',
};

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// fetch(request) desde dentro del middleware SÍ vuelve a pasar por este
// mismo middleware en este proyecto (confirmado: Vercel lo detectó y lo
// bloqueó como bucle infinito, error 508). Este header marca la petición
// interna para reconocerla al instante y no reprocesarla — el mismo truco
// que se usa en Cloudflare Workers para el mismo problema.
const BYPASS_HEADER = 'x-mfs-mw-bypass';

function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

class AttrSetter {
  constructor(attr, value) { this.attr = attr; this.value = value; }
  element(el) { if (this.value) el.setAttribute(this.attr, this.value); }
}
class TextSetter {
  constructor(value) { this.value = value; }
  element(el) { if (this.value) el.setInnerContent(this.value); }
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

    const rewriter = new HTMLRewriter()
      .on('title#pageTitleTag', new TextSetter(title))
      .on('meta#metaDescription', new AttrSetter('content', desc))
      .on('link#canonicalLink', new AttrSetter('href', pageUrl))
      .on('meta#ogTitle', new AttrSetter('content', title))
      .on('meta#ogDescription', new AttrSetter('content', desc))
      .on('meta#ogUrl', new AttrSetter('content', pageUrl))
      .on('meta#twitterTitle', new AttrSetter('content', title))
      .on('meta#twitterDescription', new AttrSetter('content', desc))
      .on('meta[property="og:image"]', new AttrSetter('content', image))
      .on('meta[name="twitter:image"]', new AttrSetter('content', image));

    return rewriter.transform(origin);
  } catch (e) {
    return;
  }
}
