// Administración del blog desde el panel (sesión de admin o personal, igual que api/productos-admin.js).
// POST { ...creds, accion: 'listar' | 'obtener' | 'guardar' | 'borrar', id?, post? }
// El HTML del artículo se limpia en el servidor (lib/blog.js, sanitizeHtml) antes de guardarse.
const { slugify, sanitizeHtml, sbBlog, SUPABASE_URL } = require('../lib/blog.js');

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function sesion(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null })
  });
  if (!r.ok) return false;
  return !!(await r.json());
}

const texto = (v, max) => { const s = String(v ?? '').trim().slice(0, max); return s || null; };
const urlImg = v => { const s = String(v || '').trim(); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 600) : null; };

function limpiarPost(p, quien) {
  const titulo = texto(p.titulo, 200);
  if (!titulo) throw Object.assign(new Error('Falta el título'), { code: 400 });
  const estado = p.estado === 'publicado' ? 'publicado' : 'borrador';
  let publicado_at = p.publicado_at ? new Date(p.publicado_at) : null;
  if (publicado_at && isNaN(publicado_at)) publicado_at = null;
  if (estado === 'publicado' && !publicado_at) publicado_at = new Date();
  return {
    slug: slugify(p.slug || titulo) || `articulo-${Date.now()}`,
    titulo,
    resumen: texto(p.resumen, 400),
    contenido: sanitizeHtml(p.contenido).slice(0, 200000),
    imagen: urlImg(p.imagen),
    imagen_alt: texto(p.imagen_alt, 200),
    meta_title: texto(p.meta_title, 120),
    meta_description: texto(p.meta_description, 320),
    palabra_clave: texto(p.palabra_clave, 80),
    etiquetas: (Array.isArray(p.etiquetas) ? p.etiquetas : String(p.etiquetas || '').split(','))
      .map(t => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12),
    autor: texto(p.autor, 80),
    estado,
    publicado_at: publicado_at ? publicado_at.toISOString() : null,
    actualizado_por: texto(quien, 100),
    updated_at: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  const body = req.body || {};
  if (!(await sesion(body).catch(() => false))) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ ok: false, error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const quien = body.p_staff_email || 'Administrador';
  const id = Number(body.id);

  try {
    if (body.accion === 'listar') {
      const posts = await sbBlog('select=id,slug,titulo,estado,publicado_at,updated_at,palabra_clave,autor,imagen&order=updated_at.desc&limit=500', serviceKey);
      return res.status(200).json({ ok: true, posts });
    }
    if (body.accion === 'obtener') {
      if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const [post] = await sbBlog(`select=*&id=eq.${id}`, serviceKey);
      return post ? res.status(200).json({ ok: true, post }) : res.status(404).json({ ok: false, error: 'No existe' });
    }
    if (body.accion === 'borrar') {
      if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts?id=eq.${id}`, { method: 'DELETE', headers: h });
      if (!r.ok) throw new Error(`borrar -> HTTP ${r.status}`);
      return res.status(200).json({ ok: true });
    }
    if (body.accion === 'guardar') {
      const row = limpiarPost(body.post || {}, quien);
      // El slug (la URL) debe ser único: si ya lo usa otro artículo se le agrega un número.
      const base = row.slug;
      for (let n = 2; n < 50; n++) {
        const [otro] = await sbBlog(`select=id&slug=eq.${row.slug}`, serviceKey);
        if (!otro || (Number.isSafeInteger(id) && otro.id === id)) break;
        row.slug = `${base}-${n}`.slice(0, 90);
      }
      let r;
      if (Number.isSafeInteger(id) && id > 0) {
        r = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts?id=eq.${id}`, { method: 'PATCH', headers: h, body: JSON.stringify(row) });
      } else {
        r = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts`, { method: 'POST', headers: h, body: JSON.stringify({ ...row, creado_por: row.actualizado_por }) });
      }
      if (!r.ok) throw new Error(`guardar -> HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      const [post] = await r.json();
      return res.status(200).json({ ok: true, post });
    }
    res.status(400).json({ ok: false, error: 'acción desconocida' });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
};
