// Vercel serverless function: la parte de la Recepción Inteligente que necesita servidor.
//
//   POST { accion: 'leer_nota', creds, recepcion_id, archivos: [{ nombre, media_type, data(base64) }] }
//        Sube la nota (fotos o PDF) al bucket privado "recepciones", la lee con Claude
//        (lib/recepcion-ia.js) y guarda códigos, cantidades y precios en la recepción. Es el único
//        camino para que una recepción tenga "nota procesada": recep_srv_guardar_lectura solo la
//        puede llamar la llave de servicio, nunca el navegador.
//   POST { accion: 'evidencia', creds, recepcion_id, linea_id?, archivo }   foto de daño/evidencia
//   POST { accion: 'archivo_url', creds, recepcion_id, path }              URL firmada (10 min)
//   POST { accion: 'sugerir_foto', creds, foto }                          productos parecidos a una foto
//   POST { accion: 'producto_nuevo', creds, nombre, precio, costo?, barcode?, categoria_id? }
//        Da de alta un producto nuevo OCULTO en la tienda (source 'recepcion'): un supervisor lo
//        revisa y lo activa en Productos.
//
// creds = getSessionCredsParams() del admin: { p_admin_password, p_staff_email, p_staff_pin }.
// Todo lo demás (vincular, contar, autorizar) lo hacen funciones de la base con la sesión.
const crypto = require('crypto');
const { leerNota, sugerirPorFoto, normalizarLectura } = require('../lib/recepcion-ia.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const BUCKET = 'recepciones';
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_ARCHIVOS = 10;
const MAX_BYTES_TOTAL = 4 * 1024 * 1024; // el cuerpo de una función de Vercel llega hasta ~4.5 MB

function servicio() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new HttpError(500, 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel');
  return key;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function rpc(fn, params) {
  const key = servicio();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
  if (!r.ok) throw new HttpError(r.status === 400 ? 400 : 502, (d && d.message) || `rpc ${fn} -> HTTP ${r.status}`);
  return d;
}

async function rest(path, opts = {}) {
  const key = servicio();
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
  if (!r.ok) throw new HttpError(502, `${path.split('?')[0]} -> HTTP ${r.status} ${typeof d === 'string' ? d.slice(0, 200) : (d && (d.message || d.error)) || ''}`);
  return d;
}

// Valida la sesión con la misma regla que las funciones de la base (recep_sesion).
async function sesion(creds) {
  const c = creds || {};
  try {
    const s = await rpc('recep_sesion', {
      p_admin_password: c.p_admin_password ?? null, p_staff_email: c.p_staff_email ?? null, p_staff_pin: c.p_staff_pin ?? null
    });
    const fila = Array.isArray(s) ? s[0] : s;
    if (!fila || !fila.nombre) throw new Error('sin sesión');
    return fila; // { nombre, supervisor, admin }
  } catch (e) {
    throw new HttpError(401, /sin_permiso_recepcion/.test(e.message) ? 'Tu usuario no tiene permiso de recepción de mercancía.' : 'Sesión no válida. Vuelve a iniciar sesión.');
  }
}

function archivoValido(a, { soloImagen = false } = {}) {
  if (!a || typeof a.data !== 'string' || !TIPOS[a.media_type]) throw new HttpError(400, 'Archivo no válido: usa foto (JPG, PNG, WEBP) o PDF.');
  if (soloImagen && a.media_type === 'application/pdf') throw new HttpError(400, 'Aquí solo se aceptan fotos.');
  const buf = Buffer.from(a.data, 'base64');
  if (!buf.length) throw new HttpError(400, 'Archivo vacío.');
  return buf;
}

async function subir(path, buf, mediaType) {
  const key = servicio();
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': mediaType, 'x-upsert': 'false' },
    body: buf
  });
  if (!r.ok) throw new HttpError(502, `No se pudo guardar el archivo (HTTP ${r.status}).`);
}

const sello = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

async function leerNotaAccion(body, s) {
  const id = Number(body.recepcion_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Falta la recepción.');
  const archivos = Array.isArray(body.archivos) ? body.archivos : [];
  if (!archivos.length) throw new HttpError(400, 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.');
  if (archivos.length > MAX_ARCHIVOS) throw new HttpError(400, `Máximo ${MAX_ARCHIVOS} páginas por nota.`);
  const bufs = archivos.map(a => archivoValido(a));
  if (bufs.reduce((t, b) => t + b.length, 0) > MAX_BYTES_TOTAL) throw new HttpError(400, 'La nota pesa demasiado: toma las fotos con menos resolución o súbela en menos páginas.');

  const hash = crypto.createHash('sha256');
  bufs.forEach(b => hash.update(b));
  const huella = hash.digest('hex');

  const info = await rpc('recep_srv_procesando', { p_id: id, p_por: s.nombre });
  try {
    const guardados = [];
    for (let i = 0; i < bufs.length; i++) {
      const path = `${info.folio}/nota-${sello()}-${i + 1}.${TIPOS[archivos[i].media_type]}`;
      await subir(path, bufs[i], archivos[i].media_type);
      guardados.push({ path, tipo: 'nota', media_type: archivos[i].media_type, nombre: String(archivos[i].nombre || '').slice(0, 120), pagina: i + 1, subido_por: s.nombre, at: new Date().toISOString() });
    }
    const lectura = await leerNota(archivos.map(a => ({ media_type: a.media_type, data: a.data })), { proveedor: info.proveedor });
    const limpia = normalizarLectura(lectura);
    if (!limpia.lineas.length) limpia.advertencias.push('La IA no encontró renglones de productos en la nota. Revisa que la foto sea de la nota y que se lea bien, o captura los renglones a mano.');
    return await rpc('recep_srv_guardar_lectura', {
      p_id: id, p_lectura: limpia, p_archivos: guardados, p_modelo: lectura.modelo || '', p_hash: huella, p_por: s.nombre
    });
  } catch (e) {
    await rpc('recep_srv_fallo', { p_id: id, p_error: e.message, p_por: s.nombre }).catch(() => {});
    throw e instanceof HttpError ? e : new HttpError(502, `No se pudo leer la nota: ${e.message}`);
  }
}

async function evidenciaAccion(body, s) {
  const id = Number(body.recepcion_id);
  const linea = body.linea_id == null ? null : Number(body.linea_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Falta la recepción.');
  const buf = archivoValido(body.archivo, { soloImagen: true });
  if (buf.length > MAX_BYTES_TOTAL) throw new HttpError(400, 'La foto pesa demasiado.');
  const det = await rpc('recep_json', { p_id: id });
  if (!det) throw new HttpError(404, 'No existe la recepción.');
  const path = `${det.recepcion.folio}/evidencia-${linea || 'general'}-${sello()}.${TIPOS[body.archivo.media_type]}`;
  await subir(path, buf, body.archivo.media_type);
  return rpc('recep_srv_evidencia', {
    p_id: id, p_linea: linea,
    p_archivo: { path, tipo: 'evidencia', media_type: body.archivo.media_type, nota: String(body.nota || '').slice(0, 200), subido_por: s.nombre, at: new Date().toISOString() },
    p_por: s.nombre
  });
}

async function archivoUrlAccion(body) {
  const det = await rpc('recep_json', { p_id: Number(body.recepcion_id) });
  if (!det) throw new HttpError(404, 'No existe la recepción.');
  const paths = new Set([...(det.recepcion.archivos || []), ...det.lineas.flatMap(l => l.evidencias || [])].map(a => a.path));
  if (!paths.has(body.path)) throw new HttpError(404, 'Ese archivo no es de esta recepción.');
  const d = await rest(`/storage/v1/object/sign/${BUCKET}/${body.path}`, { method: 'POST', body: JSON.stringify({ expiresIn: 600 }) });
  return { url: `${SUPABASE_URL}/storage/v1${d.signedURL}` };
}

async function sugerirFotoAccion(body) {
  const buf = archivoValido(body.foto, { soloImagen: true });
  if (buf.length > MAX_BYTES_TOTAL) throw new HttpError(400, 'La foto pesa demasiado.');
  const foto = { media_type: body.foto.media_type, data: body.foto.data };
  const paso1 = await sugerirPorFoto(foto);
  // Busca en el catálogo con las palabras que propuso la IA y le pide elegir entre esos.
  const palabras = [...new Set((paso1.busquedas || []).join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ñ]+/).filter(w => w.length > 2))].slice(0, 8);
  if (!palabras.length) return { descripcion: paso1.descripcion, candidatos: [] };
  const filtro = palabras.map(w => `name.ilike.*${encodeURIComponent(w)}*`).join(',');
  const rows = await rest(`/rest/v1/catalogo_productos?select=id,name,category_label,barcode,sku,images,legacy_image_url,active&or=(${filtro})&limit=300`);
  const puntuar = p => { const n = String(p.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); return palabras.filter(w => n.includes(w)).length; };
  const cand = rows.map(p => ({ ...p, _p: puntuar(p) })).sort((a, b) => b._p - a._p).slice(0, 40);
  if (!cand.length) return { descripcion: paso1.descripcion, candidatos: [] };
  const paso2 = await sugerirPorFoto(foto, cand.map(p => ({ id: p.id, name: p.name, categoria: p.category_label })));
  const porId = new Map(cand.map(p => [String(p.id), p]));
  const candidatos = (paso2.candidatos || []).map(c => {
    const p = porId.get(String(c.id));
    return p && { id: p.id, name: p.name, categoria: p.category_label, barcode: p.barcode, sku: p.sku, active: p.active,
      image: (Array.isArray(p.images) && p.images[0]) || p.legacy_image_url || null, motivo: String(c.motivo || '').slice(0, 200) };
  }).filter(Boolean).slice(0, 8);
  return { descripcion: paso2.descripcion || paso1.descripcion, candidatos };
}

async function productoNuevoAccion(body, s) {
  const nombre = String(body.nombre || '').trim().slice(0, 200);
  const precio = Number(body.precio);
  if (nombre.length < 3) throw new HttpError(400, 'Escribe el nombre del producto.');
  if (!(precio > 0)) throw new HttpError(400, 'El precio de venta debe ser mayor a 0.');
  const costo = Number(body.costo);
  const barcode = String(body.barcode || '').trim().slice(0, 60) || null;
  let categoria = {};
  if (body.categoria_id) {
    const [c] = await rest(`/rest/v1/ps_categorias?select=id,name&id=eq.${Number(body.categoria_id)}`);
    if (c) categoria = { category_id: c.id, category_label: c.name };
  }
  const slug = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  const row = {
    id: 9000000000000 + Date.now(), name: nombre, sku: barcode || slug, barcode,
    price: Math.round(precio * 100) / 100, costo_compra: costo > 0 ? Math.round(costo * 10000) / 10000 : null,
    active: false, active_override: false, source: 'recepcion', link_rewrite: slug,
    description_short: `Alta desde recepción de mercancía por ${s.nombre}. Pendiente de revisión.`,
    ...categoria, updated_at: new Date().toISOString()
  };
  const [p] = await rest('/rest/v1/catalogo_productos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  return { producto: { id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, price: p.price, active: p.active } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  const body = req.body || {};
  try {
    const s = await sesion(body.creds);
    let data;
    switch (body.accion) {
      case 'leer_nota': data = await leerNotaAccion(body, s); break;
      case 'evidencia': data = await evidenciaAccion(body, s); break;
      case 'archivo_url': data = await archivoUrlAccion(body); break;
      case 'sugerir_foto': data = await sugerirFotoAccion(body); break;
      case 'producto_nuevo': data = await productoNuevoAccion(body, s); break;
      default: throw new HttpError(400, 'Acción no válida.');
    }
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};
