// Vercel serverless function: reporte del embudo de compra para el admin
// (panel "Embudo de compra", index.html). Lee eventos_tienda (llenada por
// api/evento.js) con las funciones embudo_* de Supabase, que solo puede
// ejecutar la llave de servicio. Requiere sesión (admin o personal).
//
// POST { ...creds, accion: 'resumen', desde, hasta }
//   -> { filas: [{ origen, dispositivo, max_paso, sesiones }] (el embudo se
//        arma en el navegador a partir de esto), sesiones: [...],
//        errores: [...], abandonados: [...] }
// POST { ...creds, accion: 'sesion', sessionId }
//   -> { eventos: [{ evento, path, producto_id, valor, datos, created_at }] }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const MAX_RANGO_MS = 93 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function checkSession(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_admin_password: body.p_admin_password ?? null,
      p_staff_email: body.p_staff_email ?? null,
      p_staff_pin: body.p_staff_pin ?? null
    })
  });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

async function rpc(key, fn, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) throw new Error(`${fn} -> HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  let ok = false;
  try { ok = await checkSession(body); } catch (e) { ok = false; }
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  try {
    if (body.accion === 'sesion') {
      const sid = String(body.sessionId || '');
      if (!ID_RE.test(sid)) { res.status(400).json({ error: 'sessionId inválido' }); return; }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/eventos_tienda?session_id=eq.${sid}&select=evento,path,producto_id,valor,datos,created_at&order=created_at.asc,id.asc&limit=500`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (!r.ok) throw new Error(`eventos_tienda -> HTTP ${r.status}`);
      res.status(200).json({ eventos: await r.json() });
      return;
    }

    const desde = new Date(body.desde);
    const hasta = new Date(body.hasta);
    if (isNaN(desde) || isNaN(hasta) || hasta <= desde) { res.status(400).json({ error: 'Rango de fechas inválido' }); return; }
    if (hasta - desde > MAX_RANGO_MS) { res.status(400).json({ error: 'El rango máximo es de 90 días' }); return; }
    const p = { p_desde: desde.toISOString(), p_hasta: hasta.toISOString() };

    const [filas, sesiones, errores, abandonados] = await Promise.all([
      rpc(key, 'embudo_agregado', p),
      rpc(key, 'embudo_sesiones', { ...p, p_limite: 300 }),
      rpc(key, 'embudo_errores', p),
      rpc(key, 'embudo_abandonados', p)
    ]);
    res.status(200).json({ filas, sesiones, errores, abandonados });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo generar el reporte', detail: e.message });
  }
};
