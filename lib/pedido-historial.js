// Historial de movimientos de un pedido (tabla pedido_historial): quién hizo cada cambio, qué cambió y
// cuándo. Lo escriben las APIs del servidor con la llave de servicio; el nombre de quien actúa sale de
// la sesión (rpc_actor_name), nunca de lo que mande el navegador. Un fallo al registrar no deshace el
// cambio que ya se hizo, pero se avisa (registrar devuelve false).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function actorName(body) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_actor_name`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null })
    });
    if (!r.ok) return null;
    const name = await r.json();
    return typeof name === 'string' && name ? name : null;
  } catch (e) {
    return null;
  }
}

// entradas: [{ folio, origen, accion, detalle, usuario }]; devuelve true si se guardaron todas.
async function registrar(serviceKey, entradas) {
  const rows = (Array.isArray(entradas) ? entradas : [entradas]).filter(e => e && e.folio && e.detalle).map(e => ({
    folio: String(e.folio).slice(0, 60), origen: String(e.origen || 'online').slice(0, 20), accion: String(e.accion || 'cambio').slice(0, 30),
    detalle: String(e.detalle).slice(0, 500), usuario: String(e.usuario || 'Sistema').slice(0, 100)
  }));
  if (!rows.length) return true;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pedido_historial`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(rows)
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function listar(serviceKey, folio) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/pedido_historial?select=id,accion,detalle,usuario,created_at&folio=eq.${encodeURIComponent(folio)}&order=created_at.desc,id.desc&limit=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  if (!r.ok) throw new Error(`pedido_historial -> HTTP ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

module.exports = { actorName, registrar, listar };
