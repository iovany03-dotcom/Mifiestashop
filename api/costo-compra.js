// Vercel serverless function: llena el costo de compra (costo_compra) de
// productos del catálogo, en lote, desde el admin de "Costos y Gastos".
//
// Solo toca la columna costo_compra, y solo en productos que todavía no la
// tienen (costo_compra=is.null en el propio PATCH): nunca pisa un costo que
// ya exista. A propósito no reusa api/guardar-producto.js, que reescribe el
// producto completo (fotos, descripción, active_override…).
//
// Protegido con la misma clave de edición que la sección Costos y Gastos
// (rpc_check_edit).
//
// POST { p_edit_password, items: [{ id, costo }] }
//   -> { ok: true, actualizados: [ids], omitidos: [ids] }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const MAX_ITEMS = 500;

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
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const body = req.body || {};
  let ok = false;
  try { ok = await sbRpcServer('rpc_check_edit', { p_password: body.p_edit_password ?? null }); }
  catch (e) { res.status(401).json({ ok: false, error: 'unauthorized', detail: e.message }); return; }
  if (ok !== true) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0 || items.length > MAX_ITEMS) {
    res.status(400).json({ ok: false, error: `items debe tener entre 1 y ${MAX_ITEMS} productos` });
    return;
  }
  const limpios = [];
  for (const it of items) {
    const id = Number(it && it.id);
    const costo = Number(it && it.costo);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(costo) || costo <= 0) {
      res.status(400).json({ ok: false, error: 'Cada item necesita id entero y costo mayor a 0', item: it });
      return;
    }
    limpios.push({ id, costo: Math.round(costo * 10000) / 10000 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ ok: false, error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  const actualizados = [];
  const omitidos = [];
  try {
    for (const { id, costo } of limpios) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/catalogo_productos?id=eq.${id}&costo_compra=is.null&select=id`, {
        method: 'PATCH',
        headers: {
          apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json', Prefer: 'return=representation'
        },
        body: JSON.stringify({ costo_compra: costo, updated_at: new Date().toISOString() })
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        res.status(502).json({ ok: false, error: `Supabase HTTP ${r.status}`, detail: text.slice(0, 400), actualizados, omitidos });
        return;
      }
      const rows = await r.json();
      (Array.isArray(rows) && rows.length ? actualizados : omitidos).push(id);
    }
    res.status(200).json({ ok: true, actualizados, omitidos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, actualizados, omitidos });
  }
};
