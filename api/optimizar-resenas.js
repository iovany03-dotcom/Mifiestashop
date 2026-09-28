// TEMPORAL (quitar después de correrlo una vez): las fotos de reseñas de
// clientes se subieron a Supabase Storage sin comprimir — 1.8 a 2.7 MB cada
// una para un avatar que se muestra a 40-56px. Este endpoint las reduce
// (240x240 máx, WebP) y actualiza resenas_clientes.foto_url.
//
// Protegido con un token propio (MAINT_TOKEN en Vercel), no con la
// contraseña de admin: es una tarea de mantenimiento puntual, no una
// función del back office.
//
// GET /api/optimizar-resenas?token=... -> { procesadas: [...] }
const sharp = require('sharp');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const PREFIX = `${SUPABASE_URL}/storage/v1/object/public/assets/resenas/`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.MAINT_TOKEN;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !serviceRoleKey) { res.status(500).json({ error: 'No configurado' }); return; }
  if (req.query.token !== token) { res.status(401).json({ error: 'unauthorized' }); return; }

  const sbHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const resultados = [];

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/resenas_clientes?select=id,foto_url&foto_url=like.${encodeURIComponent(PREFIX + '%')}`, { headers: sbHeaders });
    const rows = r.ok ? await r.json() : [];

    for (const row of rows) {
      const entry = { id: row.id, antes: row.foto_url };
      try {
        if (!row.foto_url.toLowerCase().endsWith('.png')) { entry.saltado = 'no es .png'; resultados.push(entry); continue; }
        const imgRes = await fetch(row.foto_url);
        if (!imgRes.ok) throw new Error(`descarga HTTP ${imgRes.status}`);
        const original = Buffer.from(await imgRes.arrayBuffer());
        entry.bytesAntes = original.length;

        const webp = await sharp(original)
          .resize(240, 240, { fit: 'cover', position: 'attention' })
          .webp({ quality: 82 })
          .toBuffer();
        entry.bytesDespues = webp.length;

        const nombreViejo = row.foto_url.slice(PREFIX.length);
        const nombreNuevo = nombreViejo.replace(/\.png$/i, '.webp');
        const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/assets/resenas/${nombreNuevo}`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Content-Type': 'image/webp', 'x-upsert': 'true' },
          body: webp
        });
        if (!uploadRes.ok) throw new Error(`subida HTTP ${uploadRes.status}: ${(await uploadRes.text()).slice(0, 200)}`);

        const nuevaUrl = PREFIX + nombreNuevo;
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/resenas_clientes?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ foto_url: nuevaUrl })
        });
        if (!patchRes.ok) throw new Error(`guardar en Supabase HTTP ${patchRes.status}`);
        entry.despues = nuevaUrl;

        // Ya no se usa: se borra para no dejar el archivo grande huérfano en Storage.
        await fetch(`${SUPABASE_URL}/storage/v1/object/assets/resenas/${nombreViejo}`, { method: 'DELETE', headers: sbHeaders }).catch(() => {});
      } catch (e) {
        entry.error = String(e.message || e).slice(0, 200);
      }
      resultados.push(entry);
    }
    res.status(200).json({ procesadas: resultados });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
