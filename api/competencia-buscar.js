// Vercel serverless function: busca en Mercado Libre la competencia de uno o varios productos y la
// guarda en producto_privado.competencia (solo admin, ver docs/supabase-producto-competencia.sql y
// lib/competencia-ml.js). Los competidores capturados a mano en el editor se conservan.
//
// POST { ...creds de sesión, ids: [id, …] (máx. 10) }
//   -> { ok: true, resultados: [{ id, nombre, nuestro: { precio, piezas, precio_pieza }, consulta, competencia: [...] | error }] }
const { buscarCompetenciaML, guardarCompetenciaML, nuestroPrecioPieza } = require('../lib/competencia-ml.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const MAX_IDS = 10;

async function sbRpcServer(fnName, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) throw new Error(`rpc ${fnName} -> HTTP ${r.status}`);
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }

  const body = req.body || {};
  let session;
  try { session = await sbRpcServer('rpc_check_session', { p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null }); }
  catch (e) { res.status(401).json({ ok: false, error: 'unauthorized', detail: e.message }); return; }
  if (!session) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length || ids.length > MAX_IDS) { res.status(400).json({ ok: false, error: `ids debe tener entre 1 y ${MAX_IDS} productos` }); return; }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ ok: false, error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/catalogo_productos?id=in.(${ids.join(',')})&select=id,name,price`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!pr.ok) throw new Error(`leer catalogo_productos -> HTTP ${pr.status}`);
    const productos = await pr.json();
    const resultados = [];
    for (const p of productos) {
      const item = { id: p.id, nombre: p.name, nuestro: { precio: Number(p.price) || 0, ...nuestroPrecioPieza(p) } };
      try {
        const { consulta, resultados: comp } = await buscarCompetenciaML(p);
        await guardarCompetenciaML({ supabaseUrl: SUPABASE_URL, serviceKey, id: p.id, resultados: comp });
        Object.assign(item, { consulta, competencia: comp });
      } catch (e) {
        item.error = e.message;
        // Sin credenciales de ML no tiene caso seguir con el resto.
        if (/ML_CLIENT_ID/.test(e.message)) { resultados.push(item); res.status(503).json({ ok: false, error: e.message, resultados }); return; }
      }
      resultados.push(item);
    }
    res.status(200).json({ ok: true, resultados });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
