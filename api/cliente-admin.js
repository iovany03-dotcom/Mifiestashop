// Vercel serverless function: editar / eliminar un cliente desde el
// Directorio de Clientes del back office.
//
// Hay dos tipos de cliente en el directorio:
//   - origen "prestashop": fila de ps_clientes (la copia de los clientes de
//     PrestaShop). El sync de clientes es aditivo (solo trae ids nuevos),
//     así que una edición o un borrado hecho aquí no se sobrescribe.
//   - origen "web": cuenta creada en la tienda nueva (Supabase Auth).
// En los dos casos se puede fijar una contraseña: para un cliente de
// PrestaShop eso crea (o actualiza) su acceso a la tienda nueva con el
// mismo correo.
//
// Protegido con la misma sesión de admin / personal que el resto del back
// office (rpc_check_session); escribe con la llave de servicio.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, origen, id, datos }
//   accion 'obtener'  -> { cliente }
//   accion 'guardar'  -> { ok: true, cliente }
//   accion 'eliminar' -> { ok: true }
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PS_FIELDS = 'id,name,email,rfc,phone,address,city,postcode,company,birthday,active,newsletter,note,is_guest,date_add';
// Suspender una cuenta web = bloquearla por ~100 años (Supabase no tiene
// un "desactivar" como tal).
const BAN_FOREVER = '876000h';

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
  return !!(await r.json());
}

function sb(key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    async rest(path, opts = {}) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...headers, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${String(text).slice(0, 200)}`);
      return data;
    },
    async auth(path, opts = {}) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, { ...opts, headers: { ...headers, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    }
  };
}

// Cuenta web (Supabase Auth) con este correo, si existe.
async function findAuthUserByEmail(api, email) {
  const target = String(email || '').toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const r = await api.auth(`admin/users?page=${page}&per_page=1000`);
    if (!r.ok) throw new Error(`admin/users -> HTTP ${r.status}`);
    const users = Array.isArray(r.data.users) ? r.data.users : [];
    const found = users.find(u => String(u.email || '').toLowerCase() === target);
    if (found) return found;
    if (users.length < 1000) return null;
  }
  return null;
}

function webToCliente(u) {
  const meta = u.user_metadata || {};
  const banned = !!(u.banned_until && new Date(u.banned_until) > new Date());
  return {
    origen: 'web',
    id: u.id,
    nombre: meta.full_name || meta.name || '',
    email: u.email || '',
    telefono: meta.phone || '',
    rfc: meta.rfc || '',
    direccion: meta.address || '',
    cumpleanos: meta.birthday || '',
    newsletter: !!meta.newsletter,
    activo: !banned,
    confirmado: !!(u.email_confirmed_at || u.confirmed_at),
    fechaRegistro: u.created_at ? String(u.created_at).slice(0, 10) : '',
    tieneAccesoWeb: true
  };
}

function psToCliente(row, authUser) {
  return {
    origen: 'prestashop',
    id: row.id,
    nombre: row.name || '',
    email: row.email || '',
    telefono: row.phone || '',
    rfc: row.rfc || '',
    direccion: row.address || '',
    ciudad: row.city || '',
    cp: row.postcode || '',
    empresa: row.company || '',
    cumpleanos: row.birthday || '',
    newsletter: !!row.newsletter,
    activo: row.active !== false,
    nota: row.note || '',
    invitado: !!row.is_guest,
    fechaRegistro: row.date_add ? String(row.date_add).slice(0, 10) : '',
    tieneAccesoWeb: !!authUser
  };
}

function cleanText(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

// Crea o actualiza el acceso a la tienda nueva (Supabase Auth) de un
// cliente de PrestaShop, con la contraseña que puso el admin.
async function upsertWebAccess(api, email, password, meta) {
  const existing = await findAuthUserByEmail(api, email);
  if (existing) {
    const r = await api.auth(`admin/users/${existing.id}`, { method: 'PUT', body: JSON.stringify({ password }) });
    if (!r.ok) throw new Error(r.data.msg || 'No se pudo cambiar la contraseña');
    return;
  }
  const r = await api.auth('admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: meta })
  });
  if (!r.ok) throw new Error(r.data.msg || 'No se pudo crear el acceso web');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  let authorized = false;
  try { authorized = await checkSession(body); } catch (e) { authorized = false; }
  if (!authorized) { res.status(401).json({ error: 'unauthorized' }); return; }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const api = sb(serviceRoleKey);

  const { accion, origen } = body;
  const datos = body.datos && typeof body.datos === 'object' ? body.datos : {};
  const psId = origen === 'prestashop' ? parseInt(body.id, 10) : null;
  const webId = origen === 'web' ? String(body.id || '') : null;
  if (origen === 'prestashop' && !(psId > 0)) { res.status(400).json({ error: 'id inválido' }); return; }
  if (origen === 'web' && !UUID_RE.test(webId)) { res.status(400).json({ error: 'id inválido' }); return; }
  if (origen !== 'prestashop' && origen !== 'web') { res.status(400).json({ error: 'origen inválido' }); return; }

  try {
    if (accion === 'obtener') {
      if (origen === 'prestashop') {
        const rows = await api.rest(`ps_clientes?select=${PS_FIELDS}&id=eq.${psId}`);
        if (!rows || !rows[0]) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }
        const authUser = rows[0].email ? await findAuthUserByEmail(api, rows[0].email) : null;
        res.status(200).json({ cliente: psToCliente(rows[0], authUser) });
      } else {
        const r = await api.auth(`admin/users/${webId}`);
        if (!r.ok) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
        res.status(200).json({ cliente: webToCliente(r.data) });
      }
      return;
    }

    if (accion === 'guardar') {
      const nombre = cleanText(datos.nombre, 120);
      const email = cleanText(datos.email, 200).toLowerCase();
      const password = String(datos.password || '');
      if (!nombre) { res.status(400).json({ error: 'El nombre es obligatorio.' }); return; }
      if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Correo inválido.' }); return; }
      if (password && password.length < 6) { res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' }); return; }
      const cumpleanos = /^\d{4}-\d{2}-\d{2}$/.test(String(datos.cumpleanos || '')) ? datos.cumpleanos : null;
      const common = {
        telefono: cleanText(datos.telefono, 40),
        rfc: cleanText(datos.rfc, 20).toUpperCase(),
        direccion: cleanText(datos.direccion, 300)
      };

      if (origen === 'prestashop') {
        const patch = {
          name: nombre, email,
          phone: common.telefono || null, rfc: common.rfc || null, address: common.direccion || null,
          city: cleanText(datos.ciudad, 100) || null, postcode: cleanText(datos.cp, 10) || null,
          company: cleanText(datos.empresa, 150) || null, note: cleanText(datos.nota, 1000) || null,
          birthday: cumpleanos, newsletter: !!datos.newsletter, active: datos.activo !== false
        };
        const rows = await api.rest(`ps_clientes?id=eq.${psId}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
        if (!rows || !rows[0]) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }
        if (password) await upsertWebAccess(api, email, password, { full_name: nombre, phone: common.telefono, ps_customer_id: psId });
        const authUser = await findAuthUserByEmail(api, email);
        res.status(200).json({ ok: true, cliente: psToCliente(rows[0], authUser) });
        return;
      }

      const current = await api.auth(`admin/users/${webId}`);
      if (!current.ok) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
      const update = {
        email,
        email_confirm: true,
        user_metadata: {
          ...(current.data.user_metadata || {}),
          full_name: nombre, phone: common.telefono, rfc: common.rfc, address: common.direccion,
          birthday: cumpleanos, newsletter: !!datos.newsletter
        },
        ban_duration: datos.activo === false ? BAN_FOREVER : 'none'
      };
      if (password) update.password = password;
      const r = await api.auth(`admin/users/${webId}`, { method: 'PUT', body: JSON.stringify(update) });
      if (!r.ok) {
        const msg = String(r.data.msg || r.data.message || '');
        res.status(r.status === 422 && /email/i.test(msg) ? 409 : 502).json({ error: /already|registered|exists/i.test(msg) ? 'Ese correo ya lo usa otra cuenta.' : 'No se pudo guardar la cuenta.', detail: msg.slice(0, 200) });
        return;
      }
      res.status(200).json({ ok: true, cliente: webToCliente(r.data) });
      return;
    }

    if (accion === 'eliminar') {
      if (origen === 'prestashop') {
        await api.rest(`ps_clientes?id=eq.${psId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } else {
        const r = await api.auth(`admin/users/${webId}`, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) { res.status(502).json({ error: 'No se pudo eliminar la cuenta.' }); return; }
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo completar la operación.', detail: String(err.message || err).slice(0, 300) });
  }
};
