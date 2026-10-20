// Vercel serverless function: módulo SEO del panel (vista "SEO" en index.html).
//
// POST { accion, creds, ... }  — creds = getSessionCredsParams(); solo el administrador o
// personal con permiso "seo" (función seo_sesion).
//   resumen                         puntaje global, problemas principales, Google, historial
//   auditar { urls[] }              audita hasta 10 URLs ahora y guarda el resultado
//   auditorias { tipo, buscar, problema, orden, limite }
//   productos { buscar, problema, limite }       puntaje SEO de cada producto activo
//   optimizar_ia { ids[] }          propuesta de título, meta descripción y descripción (no guarda)
//   guardar_producto { id, meta_title, meta_description, descripcion? }
//   gsc { dias, dimension, buscar }  consultas o páginas de Google con comparación
//   oportunidades { dias }          palabras casi en primera página y páginas con poco CTR
//   keywords / keyword_agregar { keyword, url } / keyword_quitar { keyword }
//   inspeccionar { url }            ¿Google la tiene indexada?
//   sitemaps / enviar_sitemap
//   pagespeed { url, estrategia }   mide y guarda; velocidad (historial)
//   tecnico                         revisión técnica del sitio
const { auditarUrl } = require('../lib/seo-auditor.js');
const google = require('../lib/seo-google.js');
const { sb, sbTodo, guardarAuditorias, productosConPuntaje, promedio, conteoProblemas, ORIGEN } = require('../lib/seo-datos.js');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function sesion(creds) {
  const c = creds || {};
  let fila;
  try {
    const r = await sb('/rest/v1/rpc/seo_sesion', { method: 'POST', body: JSON.stringify({ p_admin_password: c.p_admin_password ?? null, p_staff_email: c.p_staff_email ?? null, p_staff_pin: c.p_staff_pin ?? null }) });
    fila = Array.isArray(r) ? r[0] : r;
  } catch (e) { throw new HttpError(401, 'Sesión no válida. Vuelve a iniciar sesión.'); }
  if (!fila || !fila.nombre) throw new HttpError(401, 'Sesión no válida. Vuelve a iniciar sesión.');
  if (!fila.permitido) throw new HttpError(403, 'Tu usuario no tiene permiso para el módulo SEO.');
  return fila;
}

function urlPropia(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch (e) { throw new HttpError(400, `URL inválida: ${u}`); }
  if (!/^(www\.)?mifiestashop\.com$/.test(x.hostname)) throw new HttpError(400, 'Solo se auditan páginas de mifiestashop.com.');
  x.protocol = 'https:'; x.hostname = 'www.mifiestashop.com'; x.hash = '';
  return x.toString();
}

// ---------- revisión técnica ----------
async function revisarTecnico() {
  const checks = [];
  const add = (ok, nombre, detalle, sugerencia, peso = 1) => checks.push({ ok, nombre, detalle, sugerencia, peso });
  const traer = async (u, opts = {}) => { try { return await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...opts }); } catch (e) { return null; } };

  const robots = await traer(`${ORIGEN}/robots.txt`);
  const robotsTxt = robots && robots.ok ? await robots.text() : '';
  add(!!robotsTxt, 'robots.txt existe', robotsTxt ? 'Responde 200.' : 'No responde.', 'Publica /robots.txt.', 2);
  add(!/^\s*Disallow:\s*\/\s*$/mi.test(robotsTxt), 'robots.txt no bloquea el sitio', /^\s*Disallow:\s*\/\s*$/mi.test(robotsTxt) ? 'Tiene "Disallow: /" (bloquea todo).' : 'No bloquea páginas importantes.', 'Quita "Disallow: /".', 3);
  add(/sitemap:\s*https?:\/\//i.test(robotsTxt), 'robots.txt indica el sitemap', /sitemap:/i.test(robotsTxt) ? 'Sí.' : 'No.', 'Agrega "Sitemap: https://www.mifiestashop.com/sitemap.xml".');

  const sm = await traer(`${ORIGEN}/sitemap.xml`);
  const smXml = sm && sm.ok ? await sm.text() : '';
  const locs = [...smXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const productos = locs.filter(u => /\/\d+-[^/]+\.html$/.test(u)).length;
  const categorias = locs.filter(u => /^https:\/\/[^/]+\/\d+-[^/.]+$/.test(u)).length;
  const blog = locs.filter(u => /\/blog(\/|$)/.test(u)).length;
  add(locs.length > 0, 'sitemap.xml', `${locs.length} URLs: ${productos} productos, ${categorias} categorías, ${locs.filter(u => /\/content\//.test(u)).length} páginas, ${blog} del blog.`, 'Publica /sitemap.xml.', 3);
  add(categorias > 0, 'Categorías en el sitemap', categorias ? `${categorias} categorías.` : 'No hay categorías.', 'Incluye las páginas de categoría en el sitemap.', 2);
  add(blog > 1, 'Artículos del blog en el sitemap', blog > 1 ? `${blog - 1} artículos.` : 'Todavía no hay artículos publicados.', 'Publica artículos en el Blog (SEO): atraen búsquedas de "ideas para fiesta…".');

  const http = await traer('http://www.mifiestashop.com/');
  add(http && [301, 308].includes(http.status) && /^https:/.test(http.headers.get('location') || ''), 'http redirige a https', http ? `HTTP ${http.status} → ${http.headers.get('location') || '—'}` : 'Sin respuesta.', 'Redirige todo http a https con 301.', 2);
  const sinWww = await traer('https://mifiestashop.com/');
  add(sinWww && [301, 307, 308].includes(sinWww.status) && /www\.mifiestashop\.com/.test(sinWww.headers.get('location') || ''), 'Dominio sin www redirige a www', sinWww ? `HTTP ${sinWww.status} → ${sinWww.headers.get('location') || '—'}` : 'Sin respuesta.', 'Usa un solo dominio (www) con redirección 301.', 2);
  if (sinWww && sinWww.status === 307) checks[checks.length - 1].detalle += ' (es 307 temporal; para Google es mejor 301 permanente)';
  const noExiste = await traer(`${ORIGEN}/99999999-pagina-que-no-existe.html`, { redirect: 'follow' });
  add(noExiste && noExiste.status === 404, 'Páginas inexistentes dan 404', noExiste ? `HTTP ${noExiste.status}` : 'Sin respuesta.', 'Una página que no existe debe responder 404, no 200.', 2);

  const home = await traer(`${ORIGEN}/`, { redirect: 'follow' });
  const homeHtml = home && home.ok ? await home.text() : '';
  const kb = Math.round(Buffer.byteLength(homeHtml) / 1024);
  add(kb > 0 && kb < 600, 'Peso del HTML del inicio', `${kb} KB.`, 'El inicio carga también todo el panel de administración: separarlo haría la tienda mucho más ligera para Google y para el celular.', 2);
  add(/<meta[^>]+name=["']google-site-verification["']/i.test(homeHtml) || google.gscConfigurado(), 'Search Console conectado', google.gscConfigurado() ? `Conectado a ${google.sitio()}.` : 'No conectado.', 'Conecta Search Console (pestaña Configuración) para ver posiciones reales en Google.', 2);

  const total = checks.reduce((s, c) => s + c.peso, 0);
  const puntaje = Math.round(checks.filter(c => c.ok).reduce((s, c) => s + c.peso, 0) / total * 100);
  return { puntaje, checks, sitemap_urls: locs.length };
}

// ---------- resumen ----------
async function resumen() {
  const [auds, prods, tec, hist, vel] = await Promise.all([
    sbTodo('/rest/v1/seo_auditorias?select=url,tipo,puntaje,problemas,auditado_at'),
    productosConPuntaje(),
    revisarTecnico(),
    sb('/rest/v1/seo_historial?select=*&order=fecha.desc&limit=120'),
    sb('/rest/v1/seo_pagespeed?select=url,estrategia,medido_at,performance,seo,lcp_ms,cls,tbt_ms&order=medido_at.desc&limit=20')
  ]);
  const pPag = promedio(auds.map(a => a.puntaje));
  const pProd = promedio(prods.map(p => p.puntaje));
  const partes = [[pPag, 0.4], [pProd, 0.35], [tec.puntaje, 0.25]].filter(([v]) => v !== null);
  const global = partes.length ? Math.round(partes.reduce((s, [v, w]) => s + v * w, 0) / partes.reduce((s, [, w]) => s + w, 0)) : null;
  let gsc = { configurado: google.gscConfigurado(), sitio: google.sitio() };
  if (gsc.configurado) {
    try {
      const act = await google.analitica({ ...google.rango(28), dimensiones: [], limite: 1 });
      const ant = await google.analitica({ ...google.rango(28, 31), dimensiones: [], limite: 1 });
      gsc = { ...gsc, actual: act[0] || null, anterior: ant[0] || null };
    } catch (e) { gsc.error = e.message; }
  }
  const porTipo = {};
  auds.forEach(a => { (porTipo[a.tipo] = porTipo[a.tipo] || []).push(a.puntaje); });
  return {
    puntaje_global: global,
    paginas: { auditadas: auds.length, puntaje: pPag, por_tipo: Object.fromEntries(Object.entries(porTipo).map(([k, v]) => [k, { paginas: v.length, puntaje: promedio(v) }])), ultima: auds.reduce((m, a) => (a.auditado_at > m ? a.auditado_at : m), '') || null },
    productos: { total: prods.length, puntaje: pProd, sin_meta_title: prods.filter(p => !p.meta_title).length, sin_meta_description: prods.filter(p => !p.meta_description).length, descripcion_corta: prods.filter(p => p.palabras < 120).length },
    tecnico: tec,
    problemas: conteoProblemas(auds.map(a => a.problemas)).slice(0, 12),
    problemas_productos: conteoProblemas(prods.map(p => p.problemas)).slice(0, 8),
    peores: auds.sort((a, b) => a.puntaje - b.puntaje).slice(0, 10).map(a => ({ url: a.url, tipo: a.tipo, puntaje: a.puntaje, problema: (a.problemas[0] || {}).mensaje })),
    gsc, historial: (hist || []).reverse(), velocidad: vel || []
  };
}

// ---------- productos ----------
async function productos({ buscar, problema, limite }) {
  const q = String(buscar || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let lista = await productosConPuntaje();
  if (q) lista = lista.filter(p => `${p.nombre} ${p.sku} ${p.id}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q));
  if (problema) lista = lista.filter(p => p.problemas.some(x => x.codigo === problema));
  lista.sort((a, b) => a.puntaje - b.puntaje || a.id - b.id);
  return { total: lista.length, productos: lista.slice(0, Math.min(500, Number(limite) || 200)) };
}

const ESQUEMA_SEO = {
  type: 'object', additionalProperties: false, required: ['productos'],
  properties: {
    productos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'meta_title', 'meta_description', 'descripcion_html', 'palabra_clave'],
        properties: {
          id: { type: 'integer' },
          palabra_clave: { type: 'string', description: 'Búsqueda principal en Google para este producto.' },
          meta_title: { type: 'string', description: 'Máximo 55 caracteres, sin "| Mi Fiestashop" (se agrega solo).' },
          meta_description: { type: 'string', description: '120 a 155 caracteres.' },
          descripcion_html: { type: 'string', description: 'Descripción de 120 a 220 palabras en HTML simple (<p>, <ul><li>, <strong>).' }
        }
      }
    }
  }
};

async function optimizarIA({ ids }) {
  const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger).slice(0, 3);
  if (!lista.length) throw new HttpError(400, 'Elige de 1 a 3 productos.');
  const filas = await sb(`/rest/v1/catalogo_productos?select=id,name,sku,price,price_mayoreo,price_mayoreo_desde_unidades,category_label,description,description_short,meta_title,meta_description&id=in.(${lista.join(',')})`);
  const { generarJson } = require('../lib/recepcion-ia.js');
  const texto = filas.map(p => JSON.stringify({
    id: p.id, nombre: p.name, categoria: p.category_label, precio: p.price,
    mayoreo: p.price_mayoreo ? `${p.price_mayoreo} desde ${p.price_mayoreo_desde_unidades} pzas` : null,
    descripcion_actual: String(p.description || p.description_short || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    meta_title_actual: p.meta_title, meta_description_actual: p.meta_description
  })).join('\n');
  const d = await generarJson({
    nombre: 'seo_productos', esquema: ESQUEMA_SEO, maxTokens: 12000, esfuerzo: 'low',
    sistema: `Eres especialista en SEO de comercio electrónico en México para Mi Fiestashop (artículos para fiesta, batucada, bodas, XV años, cumpleaños; venta por menudeo y mayoreo, envíos a todo México, tiendas en CDMX, Puebla y Querétaro).
Para cada producto escribe en español de México:
- palabra_clave: la búsqueda que haría un cliente en Google (ej. "collar hawaiano mayoreo").
- meta_title: máximo 55 caracteres, empieza con el producto y la palabra clave; sin el nombre de la tienda.
- meta_description: 120 a 155 caracteres, beneficio + uso en fiestas + "mayoreo" o "envío a todo México", que invite al clic.
- descripcion_html: 120 a 220 palabras, HTML simple (<p>, <ul><li>, <strong>), útil para el cliente: qué es, para qué fiestas sirve, ideas de uso, y una línea sobre mayoreo si aplica.
NUNCA inventes medidas, materiales, colores, cantidades por paquete ni datos que no estén en la información dada; si no se sabe, no lo menciones. Sin emojis. No repitas la palabra clave de forma forzada.`,
    contenido: [{ type: 'text', text: `Productos (uno por línea, JSON):\n${texto}` }]
  });
  const porId = new Map(filas.map(p => [p.id, p]));
  return {
    propuestas: (d.productos || []).filter(x => porId.has(Number(x.id))).map(x => ({
      id: Number(x.id), nombre: porId.get(Number(x.id)).name, palabra_clave: String(x.palabra_clave || '').slice(0, 80),
      meta_title: String(x.meta_title || '').slice(0, 70), meta_description: String(x.meta_description || '').slice(0, 170),
      descripcion_html: String(x.descripcion_html || '').slice(0, 6000)
    }))
  };
}

function limpiarHtml(h) {
  // Solo etiquetas simples de texto; quita scripts, estilos y atributos.
  return String(h || '')
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<(\/?)(p|ul|ol|li|strong|b|em|i|br|h2|h3)\b[^>]*>/gi, '<$1$2>')
    .replace(/<(?!\/?(p|ul|ol|li|strong|b|em|i|br|h2|h3)>)[^>]*>/gi, '')
    .trim().slice(0, 20000);
}

async function guardarProducto({ id, meta_title, meta_description, descripcion }, s) {
  const pid = Number(id);
  if (!Number.isSafeInteger(pid)) throw new HttpError(400, 'Producto inválido.');
  const cambio = { updated_at: new Date().toISOString() };
  if (meta_title !== undefined) { const t = String(meta_title).replace(/\s*\|\s*Mi Fiestashop\s*$/i, '').trim().slice(0, 70); cambio.meta_title = t || null; }
  if (meta_description !== undefined) cambio.meta_description = String(meta_description).replace(/\s+/g, ' ').trim().slice(0, 170) || null;
  if (descripcion !== undefined && String(descripcion).trim()) cambio.description = limpiarHtml(descripcion);
  const [p] = await sb(`/rest/v1/catalogo_productos?id=eq.${pid}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(cambio) });
  if (!p) throw new HttpError(404, 'No existe ese producto.');
  // La tienda muestra la descripción de productos_migrados cuando existe: se actualiza también.
  if (cambio.description) await sb(`/rest/v1/productos_migrados?id=eq.${pid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ description: cambio.description }) }).catch(() => {});
  return { guardado: true, id: pid, por: s.nombre };
}

// ---------- Google Search Console ----------
async function gsc({ dias, dimension, buscar }) {
  const n = [7, 28, 90, 180, 365].includes(Number(dias)) ? Number(dias) : 28;
  const dim = dimension === 'page' ? 'page' : 'query';
  const filtros = buscar ? [{ dimension: dim, operator: 'contains', expression: String(buscar).slice(0, 100) }] : [];
  const [act, ant] = await Promise.all([
    google.analitica({ ...google.rango(n), dimensiones: [dim], limite: 1000, filtros }),
    google.analitica({ ...google.rango(n, 3 + n), dimensiones: [dim], limite: 5000, filtros })
  ]);
  const previo = new Map(ant.map(r => [r.keys[0], r]));
  return {
    dias: n, dimension: dim,
    filas: act.map(r => { const p = previo.get(r.keys[0]); return { clave: r.keys[0], clics: r.clics, impresiones: r.impresiones, ctr: r.ctr, posicion: r.posicion, posicion_antes: p ? p.posicion : null, clics_antes: p ? p.clics : null }; })
  };
}

// CTR esperado aproximado por posición en Google (estudios públicos de CTR orgánico).
const CTR_ESPERADO = [0, 28, 15, 10, 7, 5, 4, 3, 2.5, 2, 1.7];
async function oportunidades({ dias }) {
  const n = [28, 90].includes(Number(dias)) ? Number(dias) : 28;
  const [consultas, paginas] = await Promise.all([
    google.analitica({ ...google.rango(n), dimensiones: ['query', 'page'], limite: 5000 }),
    google.analitica({ ...google.rango(n), dimensiones: ['page'], limite: 1000 })
  ]);
  const casi = consultas.filter(r => r.posicion >= 4 && r.posicion <= 20 && r.impresiones >= 20)
    .sort((a, b) => b.impresiones - a.impresiones).slice(0, 60)
    .map(r => ({ consulta: r.keys[0], pagina: r.keys[1], impresiones: r.impresiones, clics: r.clics, posicion: r.posicion }));
  const ctrBajo = paginas.filter(r => r.impresiones >= 100 && r.posicion <= 10)
    .map(r => ({ pagina: r.keys[0], impresiones: r.impresiones, clics: r.clics, ctr: r.ctr, posicion: r.posicion, ctr_esperado: CTR_ESPERADO[Math.max(1, Math.min(10, Math.round(r.posicion)))] }))
    .filter(r => r.ctr < r.ctr_esperado * 0.6).sort((a, b) => b.impresiones - a.impresiones).slice(0, 40);
  return { casi_primera_pagina: casi, ctr_bajo: ctrBajo };
}

async function keywords() {
  const lista = await sb('/rest/v1/seo_keywords?select=*&order=created_at.asc');
  if (!lista.length) return { keywords: [] };
  const desde = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const enLista = lista.map(k => `"${k.keyword.replace(/"/g, '')}"`).join(',');
  const hist = await sbTodo(`/rest/v1/seo_gsc_diario?select=fecha,consulta,clics,impresiones,posicion&consulta=in.(${encodeURIComponent(enLista)})&fecha=gte.${desde}&order=fecha.asc`);
  let actual = new Map();
  if (google.gscConfigurado()) {
    try {
      const filas = await google.analitica({ ...google.rango(28), dimensiones: ['query'], limite: 5000 });
      actual = new Map(filas.map(r => [r.keys[0].toLowerCase(), r]));
    } catch (e) { /* sin datos en vivo */ }
  }
  return {
    keywords: lista.map(k => {
      const filas = hist.filter(h => h.consulta.toLowerCase() === k.keyword.toLowerCase());
      // Posición promedio diaria ponderada por impresiones.
      const porDia = new Map();
      filas.forEach(h => { const d = porDia.get(h.fecha) || { imp: 0, pos: 0 }; d.imp += h.impresiones; d.pos += h.posicion * h.impresiones; porDia.set(h.fecha, d); });
      const serie = [...porDia.entries()].map(([fecha, d]) => ({ fecha, posicion: d.imp ? Math.round(d.pos / d.imp * 10) / 10 : null }));
      const a = actual.get(k.keyword.toLowerCase());
      return { ...k, posicion: a ? a.posicion : null, clics: a ? a.clics : null, impresiones: a ? a.impresiones : null, serie };
    })
  };
}

async function tomarPagespeed({ url, estrategia }) {
  const u = urlPropia(url);
  const est = estrategia === 'desktop' ? 'desktop' : 'mobile';
  const r = await google.pagespeed(u, est);
  await sb('/rest/v1/seo_pagespeed', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([r]) });
  return r;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  const b = req.body || {};
  try {
    const s = await sesion(b.creds);
    let data;
    switch (b.accion) {
      case 'resumen': data = await resumen(); break;
      case 'tecnico': data = await revisarTecnico(); break;
      case 'auditar': {
        const urls = [...new Set((Array.isArray(b.urls) ? b.urls : []).map(urlPropia))].slice(0, 10);
        if (!urls.length) throw new HttpError(400, 'Indica al menos una URL.');
        const resultados = await Promise.all(urls.map(u => auditarUrl(u)));
        await guardarAuditorias(resultados);
        data = { resultados }; break;
      }
      case 'auditorias': {
        let filas = await sbTodo('/rest/v1/seo_auditorias?select=*&order=puntaje.asc');
        if (b.tipo) filas = filas.filter(f => f.tipo === b.tipo);
        if (b.problema) filas = filas.filter(f => (f.problemas || []).some(p => p.codigo === b.problema));
        if (b.buscar) filas = filas.filter(f => f.url.toLowerCase().includes(String(b.buscar).toLowerCase()));
        data = { total: filas.length, auditorias: filas.slice(0, Math.min(500, Number(b.limite) || 200)) }; break;
      }
      case 'productos': data = await productos(b); break;
      case 'optimizar_ia': data = await optimizarIA(b); break;
      case 'guardar_producto': data = await guardarProducto(b, s); break;
      case 'gsc': data = await gsc(b); break;
      case 'oportunidades': data = await oportunidades(b); break;
      case 'keywords': data = await keywords(); break;
      case 'keyword_agregar': {
        const k = String(b.keyword || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
        if (k.length < 2) throw new HttpError(400, 'Escribe la palabra clave.');
        await sb('/rest/v1/seo_keywords?on_conflict=keyword', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ keyword: k, url_objetivo: b.url ? urlPropia(b.url) : null, creado_por: s.nombre }]) });
        data = await keywords(); break;
      }
      case 'keyword_quitar':
        await sb(`/rest/v1/seo_keywords?keyword=eq.${encodeURIComponent(String(b.keyword || ''))}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        data = await keywords(); break;
      case 'inspeccionar': data = await google.inspeccionarUrl(urlPropia(b.url)); break;
      case 'sitemaps': data = { sitemaps: await google.listarSitemaps() }; break;
      case 'enviar_sitemap': data = await google.enviarSitemap(`${ORIGEN}/sitemap.xml`); break;
      case 'pagespeed': data = await tomarPagespeed(b); break;
      case 'velocidad': data = { mediciones: await sb('/rest/v1/seo_pagespeed?select=*&order=medido_at.desc&limit=100') }; break;
      case 'config': data = { gsc: google.gscConfigurado(), sitio: google.sitio(), cuenta: (google.cuentaServicio() || {}).email || null, pagespeed_key: !!process.env.PAGESPEED_API_KEY, ia: !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) }; break;
      default: throw new HttpError(400, 'Acción no válida.');
    }
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || (/Search Console|Google|PageSpeed/.test(e.message) ? 502 : 500)).json({ ok: false, error: e.message });
  }
};
