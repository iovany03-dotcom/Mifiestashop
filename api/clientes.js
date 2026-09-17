// Vercel serverless function: lee los clientes desde nuestra propia copia
// en Supabase (ps_clientes), sincronizada cada hora por
// api/cron-sync-prestashop.js — ya no se consulta PrestaShop en cada
// carga del Directorio de Clientes (antes tardaba 5-8s por traer miles de
// clientes en vivo cada vez).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function fetchAllFromSupabase(table, select) {
  const PAGE_SIZE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}&order=id.desc`, {
      headers: {
        apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

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
    res.status(200).json({
      fallback: true,
      error: err.message,
      customers: [
        { id: 1, name: 'Cliente Mostrador (General)', email: 'mostrador@mifiestashop.com', rfc: 'XAXX010101000', date: '2026-01-01' }
      ]
    });
  }
};
