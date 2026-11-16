// Vercel serverless function: fotos de tienda para la comisión quincenal del personal.
// Calendario en lib/fotos-comision.js (aviso un día antes del pago; si la quincena cae en domingo,
// el pago es el sábado y el aviso el viernes).
//
//   POST { accion: 'estado', creds }                        aviso del día para quien tiene sesión
//   POST { accion: 'subir', creds, sucursal?, archivo }     una foto (JPG/PNG/WEBP en base64)
//   POST { accion: 'quitar', creds, path }                  quita una foto propia mientras está abierto
//   POST { accion: 'historial', creds, periodo?, sucursal? } (admin o permiso 'fotos-comision')
//   POST { accion: 'revisar', creds, id, estado, nota? }    aprobar / rechazar (mismo permiso)
//
// Las fotos se guardan en el bucket privado "fotos-comision" y se ven con ligas firmadas.
// La sucursal es la que tiene ligada la persona en Personal / Equipo; si tiene "Todas", la elige.
const sesion = require('../lib/sesion-panel.js');
const { credsDe } = sesion;
const cal = require('../lib/fotos-comision.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const BUCKET = 'fotos-comision';
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_FOTOS = 30;

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

// Persona del equipo de la sesión (el administrador no sube fotos).
async function empleadoDe(req) {
  const c = credsDe(req) || {};
  if (!c.p_staff_email) return null;
  const filas = await sb(`/rest/v1/personal_equipo?select=id,nombre,bodega_asignada,estado&email=ilike.${encodeURIComponent(String(c.p_staff_email).replace(/[%_*]/g, ''))}&estado=eq.Activo&limit=1`);
  return filas && filas[0] ? filas[0] : null;
}

const puedeRevisar = s => s.es_admin || (Array.isArray(s.permisos) ? s.permisos.includes('fotos-comision') : !!(s.permisos && s.permisos['fotos-comision']));

async function miRegistro(periodo, empleadoId) {
  const f = await sb(`/rest/v1/fotos_comision?select=*&periodo=eq.${periodo}&empleado_id=eq.${empleadoId}&order=id.asc`);
  return Array.isArray(f) ? f : [];
}

async function firmar(paths) {
  if (!paths.length) return {};
  const d = await sb(`/storage/v1/object/sign/${BUCKET}`, { method: 'POST', body: JSON.stringify({ expiresIn: 3600, paths }) });
  const out = {};
  (Array.isArray(d) ? d : []).forEach(x => { if (x.signedURL) out[x.path] = `${SUPABASE_URL}/storage/v1${x.signedURL}`; });
  return out;
}

async function conLigas(filas) {
  const paths = filas.flatMap(f => (f.archivos || []).map(a => a.path));
  const ligas = await firmar(paths);
  return filas.map(f => ({ ...f, archivos: (f.archivos || []).map(a => ({ ...a, url: ligas[a.path] || null })) }));
}

async function estado(req, s) {
  const hoy = cal.hoyMx();
  const abierta = cal.ventanaAbierta(hoy);
  const emp = await empleadoDe(req);
  const out = { hoy, abierta, proxima: cal.proxima(hoy), sucursales: cal.SUCURSALES, puede_revisar: puedeRevisar(s), empleado: null, envios: [] };
  if (emp) {
    out.empleado = { id: emp.id, nombre: emp.nombre, sucursal_fija: cal.sucursalDeBodega(emp.bodega_asignada) };
    if (abierta) out.envios = await conLigas(await miRegistro(abierta.periodo, emp.id));
  }
  return out;
}

async function subir(req, body) {
  const abierta = cal.ventanaAbierta(cal.hoyMx());
  if (!abierta) throw new HttpError(400, 'Hoy no está abierta la entrega de fotos. Se abre un día antes de la quincena.');
  const emp = await empleadoDe(req);
  if (!emp) throw new HttpError(403, 'Solo el personal de tienda sube fotos (entra con tu usuario, no como administrador).');
  const fija = cal.sucursalDeBodega(emp.bodega_asignada);
  const sucursal = fija || (cal.SUCURSALES[body.sucursal] ? body.sucursal : null);
  if (!sucursal) throw new HttpError(400, 'Elige la sucursal de las fotos.');
  const a = body.archivo || {};
  if (typeof a.data !== 'string' || !TIPOS[a.media_type]) throw new HttpError(400, 'Sube una foto (JPG, PNG o WEBP).');
  const buf = Buffer.from(a.data, 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new HttpError(400, 'La foto está vacía o pesa más de 3 MB.');

  const actuales = (await miRegistro(abierta.periodo, emp.id)).find(f => f.sucursal === sucursal);
  if (actuales && (actuales.archivos || []).length >= MAX_FOTOS) throw new HttpError(400, `Máximo ${MAX_FOTOS} fotos por quincena.`);
  if (actuales && actuales.estado === 'aprobado') throw new HttpError(400, 'Tus fotos de esta quincena ya se aprobaron.');

  const path = `${abierta.periodo}/${sucursal}/${emp.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${TIPOS[a.media_type]}`;
  const k = llave();
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': a.media_type, 'x-upsert': 'false' }, body: buf });
  if (!up.ok) throw new HttpError(502, `No se pudo guardar la foto (HTTP ${up.status}).`);

  const archivo = { path, media_type: a.media_type, at: new Date().toISOString() };
  if (actuales) {
    await sb(`/rest/v1/fotos_comision?id=eq.${actuales.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ archivos: [...(actuales.archivos || []), archivo], estado: 'enviado', actualizado_at: new Date().toISOString() }) });
  } else {
    await sb('/rest/v1/fotos_comision', { method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ periodo: abierta.periodo, empleado_id: emp.id, empleado: emp.nombre, sucursal, archivos: [archivo] }) });
  }
  return { ok: true, periodo: abierta.periodo, sucursal };
}

async function quitar(req, body) {
  const abierta = cal.ventanaAbierta(cal.hoyMx());
  if (!abierta) throw new HttpError(400, 'La entrega de esta quincena ya cerró.');
  const emp = await empleadoDe(req);
  if (!emp) throw new HttpError(403, 'Sin usuario de tienda.');
  const fila = (await miRegistro(abierta.periodo, emp.id)).find(f => (f.archivos || []).some(a => a.path === body.path));
  if (!fila) throw new HttpError(404, 'No se encontró la foto.');
  if (fila.estado === 'aprobado') throw new HttpError(400, 'Ya se aprobaron; no se pueden quitar.');
  await sb(`/rest/v1/fotos_comision?id=eq.${fila.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ archivos: fila.archivos.filter(a => a.path !== body.path), actualizado_at: new Date().toISOString() }) });
  await sb(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: [body.path] }) }).catch(() => null);
  return { ok: true };
}

async function historial(s, body) {
  if (!puedeRevisar(s)) throw new HttpError(403, 'Tu usuario no tiene permiso para ver las fotos de comisión.');
  const filtros = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.periodo || ''))) filtros.push(`periodo=eq.${body.periodo}`);
  if (cal.SUCURSALES[body.sucursal]) filtros.push(`sucursal=eq.${body.sucursal}`);
  const filas = await sb(`/rest/v1/fotos_comision?select=*${filtros.map(f => '&' + f).join('')}&order=periodo.desc,sucursal.asc,empleado.asc&limit=300`);
  const periodos = await sb('/rest/v1/fotos_comision?select=periodo&order=periodo.desc&limit=1000');
  return { filas: await conLigas(filas || []), periodos: [...new Set((periodos || []).map(p => p.periodo))], sucursales: cal.SUCURSALES };
}

async function revisar(s, body) {
  if (!puedeRevisar(s)) throw new HttpError(403, 'Tu usuario no tiene permiso para revisar las fotos.');
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || !['aprobado', 'rechazado', 'enviado'].includes(body.estado)) throw new HttpError(400, 'Datos incompletos.');
  await sb(`/rest/v1/fotos_comision?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ estado: body.estado, nota: String(body.nota || '').slice(0, 300) || null, revisado_por: s.nombre, revisado_at: new Date().toISOString() }) });
  return { ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Usa POST' }); return; }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const s = await sesion.sesionPanel(req);
    let data;
    switch (body.accion) {
      case 'estado': data = await estado(req, s); break;
      case 'subir': data = await subir(req, body); break;
      case 'quitar': data = await quitar(req, body); break;
      case 'historial': data = await historial(s, body); break;
      case 'revisar': data = await revisar(s, body); break;
      default: throw new HttpError(400, 'Acción no válida');
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
module.exports.HttpError = HttpError;
