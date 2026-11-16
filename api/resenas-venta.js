// Vercel serverless function: foto de la reseña del cliente ligada a cada venta (folio del ticket).
//
//   POST { accion: 'listar', creds, folios: [..] }          -> { resenas: { folio: { url, subido_por, creado_at } } }
//   POST { accion: 'subir', creds, folio, sucursal?, archivo: { media_type, data(base64) } }
//        Una reseña por venta: si ya había una, se reemplaza.
//   POST { accion: 'quitar', creds, folio }                  quien la subió o el administrador
//
// Bucket privado "resenas-venta"; las fotos se ven con ligas firmadas (1 hora).
const sesion = require('../lib/sesion-panel.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const BUCKET = 'resenas-venta';
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function llave() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new HttpError(500, 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel');
  return k;
}
async function sb(path, opts = {}) {
  const k = llave();
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers: { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
  if (!r.ok) throw new HttpError(502, `${path.split('?')[0]} -> HTTP ${r.status}`);
  return d;
}

// Folio del ticket: "#POS-21254", "WEB-196871", referencia de PrestaShop… Solo letras, números, # y -.
function folioValido(f) {
  const s = String(f || '').trim();
  if (!/^[#A-Za-z0-9_-]{2,40}$/.test(s)) throw new HttpError(400, 'Folio de ticket no válido.');
  return s;
}
const enLista = folios => folios.map(f => `"${f.replace(/"/g, '')}"`).join(',');

async function empleadoDe(req) {
  const c = sesion.credsDe(req) || {};
  if (!c.p_staff_email) return null;
  const f = await sb(`/rest/v1/personal_equipo?select=id,nombre&email=ilike.${encodeURIComponent(String(c.p_staff_email).replace(/[%_*]/g, ''))}&estado=eq.Activo&limit=1`);
  return f && f[0] ? f[0] : null;
}

async function listar(body) {
  const folios = [...new Set((Array.isArray(body.folios) ? body.folios : []).map(f => String(f || '').trim()).filter(f => /^[#A-Za-z0-9_-]{2,40}$/.test(f)))].slice(0, 500);
  if (!folios.length) return { resenas: {} };
  const filas = [];
  for (let i = 0; i < folios.length; i += 100) {
    filas.push(...(await sb(`/rest/v1/resenas_venta?select=folio,path,subido_por,creado_at,sucursal&folio=in.(${encodeURIComponent(enLista(folios.slice(i, i + 100)))})`) || []));
  }
  const firmadas = filas.length ? await sb(`/storage/v1/object/sign/${BUCKET}`, { method: 'POST', body: JSON.stringify({ expiresIn: 3600, paths: filas.map(f => f.path) }) }) : [];
  const url = {};
  (Array.isArray(firmadas) ? firmadas : []).forEach(x => { if (x.signedURL) url[x.path] = `${SUPABASE_URL}/storage/v1${x.signedURL}`; });
  const resenas = {};
  filas.forEach(f => { resenas[f.folio] = { url: url[f.path] || null, subido_por: f.subido_por, creado_at: f.creado_at, sucursal: f.sucursal }; });
  return { resenas };
}

async function subir(req, s, body) {
  const folio = folioValido(body.folio);
  const a = body.archivo || {};
  if (typeof a.data !== 'string' || !TIPOS[a.media_type]) throw new HttpError(400, 'Adjunta una foto (JPG, PNG o WEBP) de la reseña.');
  const buf = Buffer.from(a.data, 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new HttpError(400, 'La foto está vacía o pesa más de 3 MB.');
  const emp = await empleadoDe(req);
  const path = `${new Date().toISOString().slice(0, 7)}/${folio.replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now()}.${TIPOS[a.media_type]}`;
  const k = llave();
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': a.media_type, 'x-upsert': 'false' }, body: buf });
  if (!up.ok) throw new HttpError(502, `No se pudo guardar la foto (HTTP ${up.status}).`);
  const antes = await sb(`/rest/v1/resenas_venta?select=path&folio=eq.${encodeURIComponent(folio)}`);
  await sb('/rest/v1/resenas_venta?on_conflict=folio', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ folio, sucursal: String(body.sucursal || '').slice(0, 60) || null, path, media_type: a.media_type, empleado_id: emp ? emp.id : null, subido_por: s.nombre, creado_at: new Date().toISOString() }]) });
  if (antes && antes[0] && antes[0].path !== path) await sb(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: [antes[0].path] }) }).catch(() => null);
  return { ok: true, folio, reemplazada: !!(antes && antes[0]) };
}

async function quitar(s, body) {
  const folio = folioValido(body.folio);
  const f = (await sb(`/rest/v1/resenas_venta?select=path,subido_por&folio=eq.${encodeURIComponent(folio)}`) || [])[0];
  if (!f) throw new HttpError(404, 'Esta venta no tiene reseña.');
  if (!s.es_admin && f.subido_por !== s.nombre) throw new HttpError(403, `Solo ${f.subido_por} o el administrador pueden quitarla.`);
  await sb(`/rest/v1/resenas_venta?folio=eq.${encodeURIComponent(folio)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await sb(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: [f.path] }) }).catch(() => null);
  return { ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Usa POST' }); return; }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const s = await sesion.sesionPanel(req);
    let data;
    if (body.accion === 'listar') data = await listar(body);
    else if (body.accion === 'subir') data = await subir(req, s, body);
    else if (body.accion === 'quitar') data = await quitar(s, body);
    else throw new HttpError(400, 'Acción no válida');
    res.status(200).json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
