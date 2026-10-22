// Datos del módulo SEO en Supabase (tablas seo_*, ver docs/supabase-seo.sql). Lo comparten
// api/seo.js (panel) y api/cron-seo.js (auditoría y fotos diarias automáticas).
const { auditarProducto } = require('./seo-auditor.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const ORIGEN = 'https://www.mifiestashop.com';

async function sb(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en Vercel');
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status} ${txt.slice(0, 160)}`);
  return txt ? JSON.parse(txt) : null;
}

// Todas las filas de una consulta (PostgREST pagina de 1000 en 1000).
async function sbTodo(path) {
  const filas = [];
  for (let desde = 0; desde < 50000; desde += 1000) {
    const parte = await sb(path, { headers: { Range: `${desde}-${desde + 999}`, 'Range-Unit': 'items' } });
    filas.push(...parte);
    if (parte.length < 1000) break;
  }
  return filas;
}

async function guardarAuditorias(resultados) {
  if (!resultados.length) return;
  await sb('/rest/v1/seo_auditorias?on_conflict=url', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(resultados.map(r => ({
      url: r.url, tipo: r.datos.tipo, puntaje: r.puntaje, problemas: r.problemas, datos: r.datos, auditado_at: new Date().toISOString()
    })))
  });
}

async function urlsDelSitemap() {
  const r = await fetch(`${ORIGEN}/sitemap.xml`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`sitemap.xml -> HTTP ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
}

const COLUMNAS_PRODUCTO = 'id,name,sku,barcode,price,category_label,meta_title,meta_description,description,description_short,images,legacy_image_url,link_rewrite,updated_at';

async function productosConPuntaje() {
  const filas = await sbTodo(`/rest/v1/catalogo_productos?select=${COLUMNAS_PRODUCTO}&active=eq.true&order=id.asc`);
  return filas.map(p => {
    const a = auditarProducto(p);
    return {
      id: p.id, nombre: p.name, sku: p.sku, precio: p.price, categoria: p.category_label,
      meta_title: p.meta_title || '', meta_description: p.meta_description || '',
      imagen: (Array.isArray(p.images) && p.images[0]) || p.legacy_image_url || null,
      palabras: a.datos.palabras, fotos: a.datos.fotos, puntaje: a.puntaje, problemas: a.problemas
    };
  });
}

function promedio(xs) { return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null; }

// Conteo de problemas por código (para "los problemas más comunes").
function conteoProblemas(listas) {
  const c = new Map();
  listas.forEach(ps => ps.forEach(p => {
    const k = p.codigo;
    if (!c.has(k)) c.set(k, { codigo: k, nivel: p.nivel, mensaje: p.mensaje, sugerencia: p.sugerencia, veces: 0 });
    c.get(k).veces++;
  }));
  const orden = { critico: 0, alto: 1, medio: 2, bajo: 3 };
  return [...c.values()].sort((a, b) => orden[a.nivel] - orden[b.nivel] || b.veces - a.veces);
}

module.exports = { sb, sbTodo, guardarAuditorias, urlsDelSitemap, productosConPuntaje, promedio, conteoProblemas, SUPABASE_URL, ORIGEN, COLUMNAS_PRODUCTO };
