// Auditoría SEO de una página: recibe el HTML (como lo ve Googlebot) y regresa una calificación
// de 0 a 100 con la lista de problemas ordenada por impacto. Sin dependencias: se usa en
// api/seo.js (auditoría manual) y api/cron-seo.js (auditoría continua del sitemap).

const ORIGEN = 'https://www.mifiestashop.com';

function decodificar(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

// Atributos de una etiqueta, sin importar el orden ni las comillas.
function atributos(tag) {
  const a = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  const cuerpo = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  while ((m = re.exec(cuerpo))) a[m[1].toLowerCase()] = decodificar(m[3] ?? m[4] ?? m[5] ?? '');
  return a;
}

function etiquetas(html, nombre) {
  return (html.match(new RegExp(`<${nombre}\\b[^>]*>`, 'gi')) || []).map(atributos);
}

function meta(html, clave) {
  const k = clave.toLowerCase();
  const t = etiquetas(html, 'meta').find(a => (a.name || a.property || '').toLowerCase() === k);
  return t ? (t.content || '') : null;
}

// Texto visible aproximado (sin scripts, estilos ni elementos ocultos por clase "hidden").
function textoVisible(html) {
  return decodificar(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '));
}

// Contenido propio de la página: en un producto, la ficha (<article class="ssr-producto">); en una
// categoría, su introducción y sus preguntas frecuentes. Lo demás (menú, pie, sucursales, reseñas
// de la tienda) se repite igual en todas las páginas y no cuenta como contenido de ésta.
function bloquePorId(html, id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return '';
  const ini = html.lastIndexOf('<', i);
  const tag = (/^<([a-zA-Z0-9]+)/.exec(html.slice(ini)) || [])[1];
  if (!tag) return '';
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = ini;
  let prof = 0, m;
  while ((m = re.exec(html))) { prof += m[1] ? -1 : 1; if (prof === 0) return html.slice(ini, m.index + m[0].length); }
  return '';
}
function contenidoPrincipal(html, tipo) {
  if (tipo === 'producto') {
    const m = html.match(/<article class="ssr-producto">[\s\S]*?<\/article>/);
    if (m) return m[0];
  }
  if (tipo === 'categoria') {
    const b = bloquePorId(html, 'catalogCatIntro') + bloquePorId(html, 'catalogCatFaq');
    if (html.includes('id="catalogCatIntro"')) return b;
  }
  return html;
}

function tiposJsonLd(html) {
  const tipos = new Set();
  const errores = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const recorrer = n => {
        if (Array.isArray(n)) return n.forEach(recorrer);
        if (n && typeof n === 'object') {
          const t = n['@type'];
          (Array.isArray(t) ? t : [t]).filter(Boolean).forEach(x => tipos.add(String(x)));
          Object.values(n).forEach(recorrer);
        }
      };
      recorrer(JSON.parse(m[1].trim()));
    } catch (e) { errores.push('JSON-LD con error de sintaxis'); }
  }
  return { tipos: [...tipos], errores };
}

// Tipo de página por la URL del sitio.
function tipoDePagina(url) {
  let p;
  try { p = new URL(url).pathname; } catch (e) { return 'otra'; }
  if (p === '/' || p === '') return 'inicio';
  if (/^\/blog\/?$/.test(p)) return 'blog';
  if (/^\/blog\/.+/.test(p)) return 'articulo';
  if (/^\/content\//.test(p)) return 'cms';
  if (/\/\d+-[^/]+\.html$/.test(p)) return 'producto';
  if (/^\/\d+-[^/.]+$/.test(p)) return 'categoria';
  return 'otra';
}

const PESO = { critico: 25, alto: 12, medio: 6, bajo: 2 };

// html: texto de la respuesta; info: { url, status, ms, bytes, urlFinal, xRobots }
function auditarHtml(html, info) {
  const url = info.url;
  const tipo = tipoDePagina(url);
  const problemas = [];
  const add = (nivel, codigo, mensaje, sugerencia) => problemas.push({ nivel, codigo, mensaje, sugerencia });
  const datos = { tipo, status: info.status, ms: info.ms, bytes: info.bytes };

  if (info.status >= 400) {
    add('critico', 'http_error', `La página responde ${info.status}.`, 'Corrige el enlace o redirígelo (301) a una página que exista; quítala del sitemap.');
    return resultado(datos, problemas);
  }
  if (info.urlFinal && info.urlFinal !== url) add('medio', 'redireccion', `Redirige a ${info.urlFinal}.`, 'En el sitemap y en los enlaces usa directamente la URL final.');

  // Título
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const titulo = tm ? decodificar(tm[1]) : '';
  datos.titulo = titulo;
  if (!titulo) add('critico', 'sin_titulo', 'No tiene <title>.', 'Agrega un título único de 30 a 60 caracteres con la palabra clave principal.');
  else if (titulo.length < 25) add('medio', 'titulo_corto', `Título muy corto (${titulo.length} caracteres).`, 'Usa de 30 a 60 caracteres: producto + atributo + "Mi Fiestashop".');
  else if (titulo.length > 65) add('bajo', 'titulo_largo', `Título largo (${titulo.length} caracteres): Google lo cortará.`, 'Déjalo en 60 caracteres o menos.');

  // Meta descripción
  const desc = meta(html, 'description');
  datos.descripcion = desc || '';
  if (!desc) add('alto', 'sin_descripcion', 'No tiene meta descripción.', 'Escribe 120–155 caracteres que inviten al clic (beneficio + envío/mayoreo).');
  else if (desc.length < 70) add('medio', 'descripcion_corta', `Meta descripción corta (${desc.length} caracteres).`, 'Amplíala a 120–155 caracteres con beneficios y llamada a la acción.');
  else if (desc.length > 170) add('bajo', 'descripcion_larga', `Meta descripción larga (${desc.length}): se cortará.`, 'Déjala en 155 caracteres o menos.');

  // Indexación
  const robots = (meta(html, 'robots') || '') + ' ' + (info.xRobots || '');
  datos.indexable = !/noindex/i.test(robots);
  if (!datos.indexable) add('critico', 'noindex', 'La página tiene noindex: Google no la mostrará.', 'Quita noindex si la página debe aparecer en Google.');

  // Canonical
  const canon = etiquetas(html, 'link').find(a => (a.rel || '').toLowerCase().split(/\s+/).includes('canonical'));
  datos.canonical = canon ? canon.href : '';
  if (!canon || !canon.href) add('alto', 'sin_canonical', 'No tiene URL canónica.', 'Agrega <link rel="canonical"> apuntando a la URL principal de la página.');
  else {
    const normal = u => String(u).replace(/[?#].*$/, '').replace(/\/$/, '');
    if (normal(canon.href) !== normal(info.urlFinal || url)) add('medio', 'canonical_distinto', `La canónica apunta a otra URL (${canon.href}).`, 'Si la página es la principal, la canónica debe ser ella misma.');
    if (!/^https:\/\/www\.mifiestashop\.com\//.test(canon.href)) add('medio', 'canonical_dominio', 'La canónica no usa https://www.mifiestashop.com.', 'Usa siempre el dominio principal con https y www.');
  }

  // Encabezados
  const h1s = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || []);
  const h1Visibles = h1s.filter(h => !/class\s*=\s*["'][^"']*\b(hidden|sr-only)\b/i.test(h));
  datos.h1 = h1Visibles.map(h => decodificar(h.replace(/<[^>]+>/g, ' '))).filter(Boolean).slice(0, 3);
  if (!h1s.length) add('alto', 'sin_h1', 'No tiene encabezado H1.', 'Pon un solo H1 con el nombre del producto o tema de la página.');
  else if (h1s.length > 1) add('medio', 'varios_h1', `Tiene ${h1s.length} encabezados H1.`, 'Deja un solo H1 por página; los demás cámbialos a H2.');

  // Contenido
  const texto = textoVisible(contenidoPrincipal(html, tipo)).trim();
  const palabras = texto ? texto.split(/\s+/).length : 0;
  datos.palabras = palabras;
  const minimo = tipo === 'producto' ? 120 : tipo === 'categoria' ? 150 : tipo === 'articulo' ? 500 : 250;
  const sugerencia = tipo === 'producto' ? 'Agrega una descripción de 120+ palabras: medidas, material, usos, para qué fiesta.'
    : tipo === 'categoria' ? 'Escribe la introducción de la categoría (150–300 palabras) y sus preguntas frecuentes en SEO → Categorías.'
    : `Agrega texto útil (mínimo ${minimo} palabras).`;
  if (palabras < minimo) add('alto', 'poco_contenido', `Poco contenido propio (${palabras} palabras).`, sugerencia);

  // Imágenes
  const imgs = etiquetas(html, 'img');
  const sinAlt = imgs.filter(a => a.alt === undefined || a.alt === '');
  datos.imagenes = imgs.length; datos.imagenes_sin_alt = sinAlt.length;
  if (sinAlt.length) add(sinAlt.length > 5 ? 'medio' : 'bajo', 'img_sin_alt', `${sinAlt.length} de ${imgs.length} imágenes sin texto alternativo (alt).`, 'Describe cada imagen en el atributo alt (ej. "Collar hawaiano neón rosa").');

  // Datos estructurados
  const ld = tiposJsonLd(html);
  datos.jsonld = ld.tipos;
  ld.errores.forEach(e => add('alto', 'jsonld_error', e, 'Corrige el bloque JSON-LD; Google lo ignora si tiene errores.'));
  if (tipo === 'producto') {
    if (!ld.tipos.includes('Product')) add('alto', 'sin_schema_producto', 'Falta el dato estructurado Product.', 'Agrega JSON-LD Product con nombre, foto, precio y disponibilidad para salir con precio en Google.');
    else if (!ld.tipos.includes('Offer') && !ld.tipos.includes('AggregateOffer')) add('medio', 'sin_offer', 'El Product no trae Offer (precio/disponibilidad).', 'Incluye offers con price, priceCurrency MXN y availability.');
    if (!ld.tipos.includes('BreadcrumbList')) add('bajo', 'sin_breadcrumb', 'Falta BreadcrumbList.', 'Agrega migas de pan estructuradas (Inicio › Categoría › Producto).');
  }
  if (tipo === 'articulo' && !ld.tipos.some(t => /Article|BlogPosting/.test(t))) add('medio', 'sin_schema_articulo', 'Falta el dato estructurado Article.', 'Agrega JSON-LD BlogPosting con título, fecha y autor.');

  // Redes sociales
  if (!meta(html, 'og:title')) add('bajo', 'sin_og_title', 'Falta og:title (vista previa en WhatsApp/Facebook).', 'Agrega las etiquetas Open Graph.');
  if (!meta(html, 'og:image')) add('medio', 'sin_og_image', 'Falta og:image: al compartir no sale foto.', 'Agrega og:image con la foto principal (1200×630 ideal).');

  // Rendimiento básico
  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) add('alto', 'sin_viewport', 'Falta la etiqueta viewport (no se adapta a celular).', 'Agrega <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (info.bytes > 600 * 1024) add('medio', 'html_pesado', `El HTML pesa ${(info.bytes / 1024 / 1024).toFixed(1)} MB.`, 'Reduce el HTML inicial (separa el código del panel de administración de la tienda pública).');
  if (info.ms > 2500) add('medio', 'lenta', `Tardó ${(info.ms / 1000).toFixed(1)} s en responder.`, 'Revisa caché y peso de la página.');
  if (!/<html[^>]+lang\s*=/i.test(html)) add('bajo', 'sin_lang', 'Falta el idioma en <html lang>.', 'Usa <html lang="es-MX">.');

  // Enlaces internos
  const enlaces = etiquetas(html, 'a').map(a => a.href || '').filter(h => h && !/^(#|javascript:|mailto:|tel:)/i.test(h));
  datos.enlaces_internos = enlaces.filter(h => h.startsWith('/') || h.startsWith(ORIGEN)).length;
  if (datos.enlaces_internos < 3 && tipo !== 'inicio') add('bajo', 'pocos_enlaces', `Pocos enlaces internos (${datos.enlaces_internos}).`, 'Enlaza a categorías y productos relacionados.');

  return resultado(datos, problemas);
}

function resultado(datos, problemas) {
  const orden = { critico: 0, alto: 1, medio: 2, bajo: 3 };
  problemas.sort((a, b) => orden[a.nivel] - orden[b.nivel]);
  const puntos = Math.max(0, 100 - problemas.reduce((s, p) => s + PESO[p.nivel], 0));
  return { puntaje: puntos, datos, problemas };
}

async function auditarUrl(url, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) MiFiestashopSEO/1.0' }
    });
  } catch (e) {
    return { url, puntaje: 0, datos: { tipo: tipoDePagina(url), status: 0 }, problemas: [{ nivel: 'critico', codigo: 'sin_respuesta', mensaje: `No respondió: ${e.message}`, sugerencia: 'Revisa que la página exista y cargue.' }] };
  }
  const html = await r.text();
  const ms = Date.now() - t0;
  const res = auditarHtml(html, { url, status: r.status, ms, bytes: Buffer.byteLength(html), urlFinal: r.url, xRobots: r.headers.get('x-robots-tag') || '' });
  return { url, ...res };
}

// Puntaje SEO de un producto con los datos del catálogo (sin descargar la página).
function auditarProducto(p) {
  const problemas = [];
  const add = (nivel, codigo, mensaje) => problemas.push({ nivel, codigo, mensaje });
  const nombre = String(p.name || '').trim();
  const mt = String(p.meta_title || '').trim();
  const md = String(p.meta_description || '').trim();
  const desc = decodificar(String(p.description || '').replace(/<[^>]+>/g, ' '));
  const palabras = desc ? desc.split(/\s+/).length : 0;
  const fotos = (Array.isArray(p.images) ? p.images.length : 0) || (p.legacy_image_url ? 1 : 0);
  if (!mt) add('alto', 'sin_meta_title', 'Sin título SEO (usa solo el nombre).');
  else if (mt.length > 65) add('bajo', 'meta_title_largo', `Título SEO largo (${mt.length}).`);
  if (!md) add('alto', 'sin_meta_description', 'Sin meta descripción.');
  else if (md.length < 70) add('medio', 'meta_description_corta', `Meta descripción corta (${md.length}).`);
  else if (md.length > 170) add('bajo', 'meta_description_larga', `Meta descripción larga (${md.length}).`);
  if (palabras < 40) add('alto', 'descripcion_muy_corta', `Descripción de ${palabras} palabras.`);
  else if (palabras < 120) add('medio', 'descripcion_corta', `Descripción de ${palabras} palabras (ideal 120+).`);
  if (!fotos) add('critico', 'sin_foto', 'Sin foto.');
  else if (fotos < 2) add('bajo', 'una_foto', 'Solo 1 foto.');
  if (nombre.length < 12) add('medio', 'nombre_corto', 'Nombre muy corto: agrega tipo, color o medida.');
  if (!p.category_label || /^(inicio|home|general)$/i.test(p.category_label)) add('medio', 'sin_categoria', 'Sin categoría específica.');
  return resultado({ palabras, fotos }, problemas);
}

module.exports = { auditarHtml, auditarUrl, auditarProducto, tipoDePagina, textoVisible, atributos };
