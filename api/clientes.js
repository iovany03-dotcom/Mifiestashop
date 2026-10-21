// Vercel serverless function: lee los clientes desde nuestra propia copia
// en Supabase (ps_clientes), el histórico que quedó de PrestaShop.
const { exigirSesion } = require('../lib/sesion-panel.js');
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

async function fetchAllFromSupabase(table, select) {
  const PAGE_SIZE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}&order=id.desc`, {
      headers: {
        apikey: LLAVE_SERVICIO(), Authorization: `Bearer ${LLAVE_SERVICIO()}`,
        Range: `${from}-${from + PAGE_SIZE - 1}`
      }
    });
    if (!r.ok) break;
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

const LLAVE_SERVICIO = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
module.exports = async function handler(req, res) {
  // Datos privados del panel: solo con sesión (lib/sesion-panel.js) y nunca en la caché del CDN.
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await exigirSesion(req, res))) return;

  try {
    const rows = await fetchAllFromSupabase(
      'ps_clientes',
      'id,name,email,rfc,phone,city,active,date_add,birthday,company,newsletter,is_guest'
    );

    const customers = rows.map(c => ({
      id: c.id,
      name: c.name || 'Cliente PrestaShop',
      email: c.email || '—',
      rfc: c.rfc || '—',
      phone: c.phone || '—',
      city: c.city || '—',
      date: c.date_add ? String(c.date_add).slice(0, 10) : '—',
      active: !!c.active,
      birthday: c.birthday || null,
      company: c.company || null,
      newsletter: !!c.newsletter,
      isGuest: !!c.is_guest
    }));

    res.status(200).json({ customers, count: customers.length, source: 'supabase' });
  } catch (err) {
    // Sin clientes de ejemplo: si falla la consulta se avisa con el error y la lista queda vacía.
    res.status(200).json({ error: err.message, customers: [] });
  }
};
