// Cola de optimización SEO con IA (tabla seo_cola_productos):
//   llenar()   mete los productos activos que les falta título SEO, meta descripción o una
//              descripción de 120+ palabras; los más vendidos primero.
//   procesar() la IA propone (de 3 en 3) para los pendientes, hasta agotar el tiempo.
//   aprobar()  guarda las propuestas en el producto (y deja copia de lo anterior para deshacer).
//   aprobarAutomaticas() con la aprobación automática activada: aprueba las que pasan revisarPropuesta().
//   rechazar() / deshacer() / resumen() / lista()
const { sb, sbTodo, productosConPuntaje } = require('./seo-datos.js');
const { optimizarIA, guardarProducto, HttpError } = require('./seo-ia.js');

const NECESITA = new Set(['sin_meta_title', 'sin_meta_description', 'meta_title_largo', 'meta_description_corta', 'meta_description_larga', 'descripcion_muy_corta', 'descripcion_corta']);
const LOTE = 3;
const MAX_INTENTOS = 3;

async function ventasPorProducto() {
  const total = new Map();
  const sumar = filas => filas.forEach(r => { const id = Number(r.product_id); if (id) total.set(id, (total.get(id) || 0) + (Number(r.units) || 0)); });
  sumar(await sbTodo('/rest/v1/ps_ventas_producto_mes?select=product_id,units').catch(() => []));
  sumar(await sbTodo('/rest/v1/pos_ventas_producto_mes?select=product_id,units').catch(() => []));
  return total;
}

async function llenar() {
  const [prods, ventas, ya] = await Promise.all([productosConPuntaje(), ventasPorProducto(), sbTodo('/rest/v1/seo_cola_productos?select=product_id')]);
  const enCola = new Set(ya.map(r => Number(r.product_id)));
  const nuevos = prods.filter(p => !enCola.has(Number(p.id)) && p.problemas.some(x => NECESITA.has(x.codigo)))
    .map(p => ({ product_id: p.id, prioridad: ventas.get(Number(p.id)) || 0, estado: 'pendiente' }));
  for (let i = 0; i < nuevos.length; i += 500) {
    await sb('/rest/v1/seo_cola_productos?on_conflict=product_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(nuevos.slice(i, i + 500)) });
  }
  return { agregados: nuevos.length };
}

const patch = (filtro, cambio) => sb(`/rest/v1/seo_cola_productos?${filtro}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(cambio) });

async function procesarLote(lote) {
  let propuestos = 0, errores = 0, sinCredito = false;
  const ids = lote.map(r => Number(r.product_id));
  try {
    const { propuestas } = await optimizarIA({ ids });
    const porId = new Map(propuestas.map(p => [Number(p.id), p]));
    for (const r of lote) {
      const p = porId.get(Number(r.product_id));
      if (p && p.meta_title && p.descripcion_html) {
        await patch(`product_id=eq.${r.product_id}`, { estado: 'propuesto', propuesta: { palabra_clave: p.palabra_clave, meta_title: p.meta_title, meta_description: p.meta_description, descripcion_html: p.descripcion_html }, propuesto_at: new Date().toISOString(), error: null });
        propuestos++;
      } else {
        await patch(`product_id=eq.${r.product_id}`, { estado: 'error', intentos: (r.intentos || 0) + 1, error: 'La IA no devolvió propuesta para este producto (puede estar inactivo).' });
        errores++;
      }
    }
  } catch (e) {
    for (const r of lote) await patch(`product_id=eq.${r.product_id}`, { estado: 'error', intentos: (r.intentos || 0) + 1, error: String(e.message || e).slice(0, 300) });
    errores += lote.length;
    sinCredito = /401|429|quota|credit|insufficient/i.test(String(e.message)); // sin crédito o sin llave: no seguir gastando intentos
  }
  return { propuestos, errores, sinCredito };
}

// paralelo: cuántos lotes de 3 se piden a la IA al mismo tiempo.
async function procesar({ tiempoMaxMs = 200000, paralelo = 1 } = {}) {
  const t0 = Date.now();
  let propuestos = 0, errores = 0;
  while (Date.now() - t0 < tiempoMaxMs - 60000) {
    const filas = await sb(`/rest/v1/seo_cola_productos?or=(estado.eq.pendiente,and(estado.eq.error,intentos.lt.${MAX_INTENTOS}))&select=product_id,intentos&order=estado.desc,prioridad.desc,product_id.asc&limit=${LOTE * paralelo}`);
    if (!filas.length) break;
    const lotes = [];
    for (let i = 0; i < filas.length; i += LOTE) lotes.push(filas.slice(i, i + LOTE));
    const res = await Promise.all(lotes.map(procesarLote));
    res.forEach(r => { propuestos += r.propuestos; errores += r.errores; });
    if (res.some(r => r.sinCredito)) break;
  }
  return { propuestos, errores, segundos: Math.round((Date.now() - t0) / 1000) };
}

// ---------- aprobación automática (la activa el administrador; se guarda en ps_sync_estado 'seo_ia_auto') ----------
const AUTO = { nombre: 'IA (aprobación automática)' };
async function autoActivo() {
  const [r] = await sb('/rest/v1/ps_sync_estado?dominio=eq.seo_ia_auto&select=last_synced_id');
  return Number(r && r.last_synced_id) === 1;
}
async function ponerAuto(activo, s) {
  await sb('/rest/v1/ps_sync_estado?on_conflict=dominio', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ dominio: 'seo_ia_auto', last_synced_id: activo ? 1 : 0, last_synced_at: new Date().toISOString(), ultimo_resultado: `${activo ? 'Activada' : 'Desactivada'} por ${s ? s.nombre : 'Sistema'}` }])
  });
  return { auto: !!activo };
}

const palabrasDe = h => (String(h || '').replace(/<[^>]+>/g, ' ').match(/\S+/g) || []).length;
// Controles antes de aprobar sin que nadie revise; lo que no pasa se queda "Por revisar" con la razón.
function revisarPropuesta(p) {
  const fallas = [];
  const t = String(p.meta_title || '').replace(/\s*\|\s*Mi Fiestashop\s*$/i, '').trim();
  const m = String(p.meta_description || '').trim();
  const d = String(p.descripcion_html || '');
  const w = palabrasDe(d);
  if (t.length < 15 || t.length > 60) fallas.push(`título de ${t.length} caracteres`);
  if (m.length < 90 || m.length > 170) fallas.push(`meta de ${m.length} caracteres`);
  if (w < 80 || w > 400) fallas.push(`descripción de ${w} palabras`);
  if (/<\s*(script|iframe|style|img|a)\b|https?:\/\/|www\./i.test(d + m)) fallas.push('trae enlaces o código');
  if (/\$\s?\d/.test(d + m + t)) fallas.push('menciona precios');
  // Título con relleno: una palabra (de más de 3 letras) repetida, p. ej. "Globo Gato globo gato mayoreo".
  const vistas = new Set();
  const norm = x => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (norm(t).split(/[^a-z0-9ñ]+/).filter(x => x.length > 3).some(x => (vistas.has(x) ? true : (vistas.add(x), false)))) fallas.push('título con palabras repetidas');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(d + m + t)) fallas.push('trae emojis');
  return fallas;
}

async function aprobarAutomaticas({ maximo = 500 } = {}) {
  let aprobados = 0, aRevisar = 0;
  while (aprobados + aRevisar < maximo) {
    const filas = await sb(`/rest/v1/seo_cola_productos?estado=eq.propuesto&error=is.null&select=product_id,propuesta&order=prioridad.desc,product_id.asc&limit=50`);
    if (!filas.length) break;
    const buenos = [];
    for (const f of filas) {
      const fallas = revisarPropuesta(f.propuesta || {});
      if (fallas.length) { await patch(`product_id=eq.${f.product_id}`, { error: `Revisar a mano: ${fallas.join(', ')}.` }); aRevisar++; }
      else buenos.push(Number(f.product_id));
    }
    if (buenos.length) {
      const r = await aprobar({ ids: buenos }, AUTO);
      aprobados += r.aprobados;
      for (const f of r.fallidos) { await patch(`product_id=eq.${f.id}`, { error: `No se pudo guardar: ${f.error}`.slice(0, 300) }); aRevisar++; }
    }
  }
  return { aprobados, a_revisar: aRevisar };
}

async function resumen() {
  const filas = await sbTodo('/rest/v1/seo_cola_productos?select=estado');
  const c = { pendiente: 0, propuesto: 0, aprobado: 0, rechazado: 0, error: 0 };
  filas.forEach(f => { c[f.estado] = (c[f.estado] || 0) + 1; });
  return { ...c, total: filas.length };
}

async function lista({ estado = 'propuesto', limite = 30, desde = 0 } = {}) {
  const est = ['pendiente', 'propuesto', 'aprobado', 'rechazado', 'error'].includes(estado) ? estado : 'propuesto';
  const n = Math.min(100, Math.max(1, Number(limite) || 30));
  const filas = await sb(`/rest/v1/seo_cola_productos?estado=eq.${est}&select=*&order=prioridad.desc,product_id.asc&limit=${n}&offset=${Math.max(0, Number(desde) || 0)}`);
  if (!filas.length) return { items: [] };
  const prods = await sb(`/rest/v1/catalogo_productos?id=in.(${filas.map(f => f.product_id).join(',')})&select=id,name,category_label,meta_title,meta_description,description,images,legacy_image_url`);
  const porId = new Map(prods.map(p => [Number(p.id), p]));
  return {
    items: filas.map(f => {
      const p = porId.get(Number(f.product_id)) || {};
      return {
        id: Number(f.product_id), estado: f.estado, prioridad: Number(f.prioridad) || 0, error: f.error,
        nombre: p.name || `#${f.product_id}`, categoria: p.category_label || '', imagen: (Array.isArray(p.images) && p.images[0]) || p.legacy_image_url || null,
        actual: { meta_title: p.meta_title || '', meta_description: p.meta_description || '', descripcion_html: p.description || '' },
        propuesta: f.propuesta, revisado_por: f.revisado_por, revisado_at: f.revisado_at
      };
    })
  };
}

// ediciones: { [id]: { meta_title, meta_description, descripcion_html } } — lo que el usuario corrigió antes de aprobar.
async function aprobar({ ids, ediciones }, s) {
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger))].slice(0, 100);
  if (!lista.length) throw new HttpError(400, 'Elige al menos una propuesta.');
  const filas = await sb(`/rest/v1/seo_cola_productos?product_id=in.(${lista.join(',')})&estado=eq.propuesto&select=product_id,propuesta`);
  const [actuales, migrados] = await Promise.all([
    sb(`/rest/v1/catalogo_productos?id=in.(${lista.join(',')})&select=id,meta_title,meta_description,description`),
    sb(`/rest/v1/productos_migrados?id=in.(${lista.join(',')})&select=id,description`).catch(() => [])
  ]);
  const porId = new Map(actuales.map(p => [Number(p.id), p]));
  const migPorId = new Map(migrados.map(p => [Number(p.id), p.description]));
  let aprobados = 0;
  const fallidos = [];
  for (const f of filas) {
    const id = Number(f.product_id);
    const e = (ediciones && ediciones[id]) || {};
    const v = { ...(f.propuesta || {}), ...e };
    try {
      await guardarProducto({ id, meta_title: v.meta_title, meta_description: v.meta_description, descripcion: v.descripcion_html }, s);
      const a = porId.get(id) || {};
      await patch(`product_id=eq.${id}`, { estado: 'aprobado', propuesta: v, antes: { meta_title: a.meta_title || null, meta_description: a.meta_description || null, description: a.description || null, description_migrado: migPorId.get(id) ?? null }, revisado_at: new Date().toISOString(), revisado_por: s.nombre });
      aprobados++;
    } catch (err) { fallidos.push({ id, error: err.message }); }
  }
  return { aprobados, fallidos };
}

async function rechazar({ ids }, s) {
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger))].slice(0, 100);
  if (!lista.length) throw new HttpError(400, 'Elige al menos una propuesta.');
  await patch(`product_id=in.(${lista.join(',')})&estado=in.(propuesto,error,pendiente)`, { estado: 'rechazado', revisado_at: new Date().toISOString(), revisado_por: s.nombre });
  return { rechazados: lista.length };
}

// Vuelve a dejar el producto como estaba antes de aprobar.
async function deshacer({ id }, s) {
  const pid = Number(id);
  const [f] = await sb(`/rest/v1/seo_cola_productos?product_id=eq.${pid}&estado=eq.aprobado&select=antes`);
  if (!f || !f.antes) throw new HttpError(404, 'No hay un cambio aprobado que deshacer en ese producto.');
  await sb(`/rest/v1/catalogo_productos?id=eq.${pid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ meta_title: f.antes.meta_title, meta_description: f.antes.meta_description, description: f.antes.description, updated_at: new Date().toISOString() }) });
  if (f.antes.description_migrado !== undefined) await sb(`/rest/v1/productos_migrados?id=eq.${pid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ description: f.antes.description_migrado }) }).catch(() => {});
  await patch(`product_id=eq.${pid}`, { estado: 'propuesto', revisado_at: new Date().toISOString(), revisado_por: s.nombre });
  return { deshecho: true, id: pid };
}

// Vuelve a pedir a la IA (p. ej. una propuesta rechazada o con error).
async function reintentar({ ids }) {
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger))].slice(0, 100);
  if (!lista.length) throw new HttpError(400, 'Elige al menos un producto.');
  await patch(`product_id=in.(${lista.join(',')})&estado=in.(rechazado,error,propuesto)`, { estado: 'pendiente', intentos: 0, error: null });
  return { reencolados: lista.length };
}

module.exports = { llenar, procesar, resumen, lista, aprobar, rechazar, deshacer, reintentar, autoActivo, ponerAuto, aprobarAutomaticas, revisarPropuesta, NECESITA };
