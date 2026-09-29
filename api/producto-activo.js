// Vercel serverless function: activa/desactiva un producto directamente en
// Supabase, desde el admin.
//
// Ya no dependemos de PrestaShop como tienda en vivo (ver
// lib/prestashop.js), pero el catálogo se sigue sincronizando desde ahí en
// segundo plano (lib/sync-prestashop.js, dominio "productos" cada 10 min) —
// sin nada más, ese ciclo pisaría este cambio con lo que diga PrestaShop en
// la siguiente corrida. Por eso esto no solo cambia "active": también marca
// "active_override", que el propio sync respeta y deja de tocar (ver
// fetchActiveOverrideIds en lib/sync-prestashop.js).
//
// Solo toca estas dos columnas — a propósito no reusa el flujo completo de
// api/guardar-producto.js (que reescribe todo el producto) para no arriesgar
// pisar descripción/fotos/precios con lo que hubiera quedado cargado en el
// formulario del editor.
//
// POST { ...creds, id, activo } -> { ok: true }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

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
  const p_admin_password = body.p_admin_password ?? null;
  const p_staff_email = body.p_staff_email ?? null;
  const p_staff_pin = body.p_staff_pin ?? null;

  let session;
  try { session = await sbRpcServer('rpc_check_session', { p_admin_password, p_staff_email, p_staff_pin }); }
  catch (e) { res.status(401).json({ ok: false, error: 'unauthorized', detail: e.message }); return; }
  if (!session) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ ok: false, error: 'Falta el id del producto' }); return; }
  const activo = body.activo === true;

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ ok: false, error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/catalogo_productos?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({ active: activo, active_override: activo, updated_at: new Date().toISOString() })
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      res.status(502).json({ ok: false, error: `Supabase HTTP ${r.status}`, detail: text.slice(0, 400) });
      return;
    }
    res.status(200).json({ ok: true, id, activo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
