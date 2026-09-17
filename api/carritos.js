// Vercel serverless function: lee los carritos desde nuestra propia copia
// en Supabase (ps_carritos), sincronizada cada hora por
// api/cron-sync-prestashop.js (incluye ya resueltos nombre/sku/precio/imagen
// de cada producto). El estado (activo/abandonado/convertido) se calcula
// aquí, en cada lectura, a partir de date_upd y order_reference — no se
// guarda estático, porque "abandonado" depende de cuánto tiempo ha pasado
// desde la última sincronización, no de un valor fijo.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const select = 'id,customer_name,customer_email,items,order_reference,date_add,date_upd';
    const url = `${SUPABASE_URL}/rest/v1/ps_carritos?select=${select}&order=id.desc`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!r.ok) throw new Error(`Supabase error ${r.status}`);

    const rawCarts = await r.json();
    const now = Date.now();

    const carts = rawCarts.map(c => {
      const items = (Array.isArray(c.items) ? c.items : []).map(it => ({
        name: it.name || `Producto #${it.id_product}`,
        sku: it.sku || '',
        qty: it.qty || 1,
        price: it.price || 0,
        img: it.img || ''
      }));

      const hoursSinceUpdate = (now - new Date(c.date_upd).getTime()) / 36e5;
      let status = 'active';
      let statusText = 'Activo (En Proceso)';
      if (c.order_reference) {
        status = 'converted';
        statusText = `Convertido (${c.order_reference})`;
      } else if (hoursSinceUpdate > 24) {
        status = 'abandoned';
        statusText = 'Abandonado (>24h)';
      }

      return {
        id: `CR-${c.id}`,
        date: c.date_add,
        customer: c.customer_name || `Invitado #${c.id}`,
        email: c.customer_email || 'invitado.web@mifiestashop.com',
        status,
        statusText,
        items
      };
    });

    res.status(200).json({ carts, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, carts: [] });
  }
};
