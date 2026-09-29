// Vercel serverless function: recibe los eventos del embudo de compra de la
// tienda pública (ver trackFunnel() en index.html) y los guarda en
// eventos_tienda (Supabase). El panel "Embudo de compra" del admin
// (api/embudo.js) los agrupa por sesión para ver en qué paso se queda cada
// visitante.
//
// POST { events: [{ v, s, e, p, t, pid, val, o, dv, d }] }
//   v: id anónimo del visitante (localStorage)   s: id de la sesión
//   e: evento (ver EVENTOS)                       p: ruta de la página
//   t: hora del navegador (ms)                    pid: id de producto
//   val: valor en MXN                             o: origen de la visita
//   dv: dispositivo                               d: datos extra (objeto)
//
// Público a propósito (lo llama cualquier visitante, igual que el píxel de
// Meta) — por eso valida todo, limita tamaños, ignora bots y nunca guarda
// correo/teléfono/nombre del cliente.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

const EVENTOS = new Set([
  'visita', 'ver_producto', 'buscar', 'agregar_carrito', 'ver_carrito',
  'iniciar_checkout', 'cotizar_envio', 'elegir_envio', 'error_checkout',
  'pedido_creado', 'ir_a_pago', 'compra', 'pago_pendiente', 'pago_rechazado',
  'contacto', 'registro', 'newsletter'
]);
const ORIGENES = new Set(['facebook', 'instagram', 'google', 'tiktok', 'whatsapp', 'email', 'otro', 'directo']);
const DISPOSITIVOS = new Set(['movil', 'tablet', 'escritorio']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor/i;
const MAX_EVENTS = 50;

function cleanDatos(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  for (const [k, v] of Object.entries(d).slice(0, 15)) {
    if (!/^[a-z_]{1,30}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

function toRow(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const v = String(ev.v || ''), s = String(ev.s || ''), e = String(ev.e || '');
  if (!ID_RE.test(v) || !ID_RE.test(s) || !EVENTOS.has(e)) return null;
  const pid = parseInt(ev.pid, 10);
  const val = Number(ev.val);
  const t = Number(ev.t);
  return {
    visitor_id: v,
    session_id: s,
    evento: e,
    path: typeof ev.p === 'string' ? ev.p.slice(0, 300) : null,
    producto_id: Number.isFinite(pid) && pid > 0 ? pid : null,
    valor: Number.isFinite(val) && val >= 0 && val < 10000000 ? Math.round(val * 100) / 100 : null,
    datos: cleanDatos(ev.d),
    origen: ORIGENES.has(ev.o) ? ev.o : 'directo',
    dispositivo: DISPOSITIVOS.has(ev.dv) ? ev.dv : null,
    client_ts: Number.isFinite(t) ? Math.round(t) : null
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  if (BOT_RE.test(String(req.headers['user-agent'] || ''))) { res.status(204).end(); return; }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) { res.status(204).end(); return; }

  // navigator.sendBeacon manda text/plain, así que el cuerpo puede llegar
  // como texto sin parsear.
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > 100000) { res.status(413).json({ error: 'Demasiado grande' }); return; }
    try { body = JSON.parse(body); } catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }
  }
  const events = Array.isArray(body && body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  const rows = events.map(toRow).filter(Boolean);
  if (rows.length === 0) { res.status(204).end(); return; }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/eventos_tienda`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify(rows)
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`eventos_tienda -> HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.error('eventos_tienda:', e.message);
  }
  // Nunca se le reporta un error al navegador: el rastreo es secundario a
  // la compra y no debe generar reintentos ni ruido en la consola.
  res.status(204).end();
};

module.exports.toRow = toRow;
