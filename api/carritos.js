// Vercel serverless function: junta los carritos de DOS fuentes.
//
// 1) ps_carritos: nuestra copia de los carritos de PrestaShop (sincronizada
//    cada hora por api/cron-sync-prestashop.js) — lo que se genere del lado
//    de PrestaShop (ej. POS de tienda física).
// 2) carritos_web: carritos guardados en vivo por el propio sitio nuevo
//    (api/carrito-guardar.js), desde que la tienda en línea dejó de tocar
//    PrestaShop (ver docs/dominio-mifiestashop-com.md) — sin esto, un
//    carrito abandonado en mifiestashop.com no se veía en ningún lado.
//
// El estado (activo/abandonado/convertido) se calcula aquí, en cada
// lectura, a partir de la fecha de actualización y de si tiene folio de
// pedido — no se guarda estático, porque "abandonado" depende de cuánto
// tiempo ha pasado, no de un valor fijo.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

function computeStatus(dateUpd, orderReference) {
  const hoursSinceUpdate = (Date.now() - new Date(dateUpd).getTime()) / 36e5;
  if (orderReference) return { status: 'converted', statusText: `Convertido (${orderReference})` };
  if (hoursSinceUpdate > 24) return { status: 'abandoned', statusText: 'Abandonado (>24h)' };
  return { status: 'active', statusText: 'Activo (En Proceso)' };
}

async function fetchPsCarritos() {
  const select = 'id,customer_name,customer_email,items,order_reference,date_add,date_upd';
  // Solo los carritos de Mi Fiestashop (tienda 50): la instalación de
  // PrestaShop es compartida y antes se colaban carritos vacíos de otras
  // tiendas (se veían como "Invitado" en $0).
  const url = `${SUPABASE_URL}/rest/v1/ps_carritos?select=${select}&id_shop=eq.50&order=id.desc`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error(`Supabase error ${r.status}`);
  const rawCarts = await r.json();

  return rawCarts.map(c => {
    const items = (Array.isArray(c.items) ? c.items : []).map(it => ({
      name: it.name || `Producto #${it.id_product}`,
      sku: it.sku || '',
      qty: it.qty || 1,
      price: it.price || 0,
      img: it.img || ''
    }));
    const { status, statusText } = computeStatus(c.date_upd, c.order_reference);
    return {
      id: `CR-${c.id}`,
      date: c.date_add,
      customer: c.customer_name || `Invitado #${c.id}`,
      email: c.customer_email || 'invitado.web@mifiestashop.com',
      status, statusText, items
    };
  });
}

async function fetchCarritosWeb(serviceRoleKey) {
  if (!serviceRoleKey) return [];
  const select = 'id,customer_name,customer_email,items,order_reference,date_add,date_upd';
  const url = `${SUPABASE_URL}/rest/v1/carritos_web?select=${select}&order=id.desc&limit=500`;
  const r = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
  if (!r.ok) throw new Error(`Supabase error ${r.status}`);
  const rawCarts = await r.json();

  return rawCarts.map(c => {
    const items = (Array.isArray(c.items) ? c.items : []).map(it => ({
      name: it.name || `Producto #${it.id}`,
      sku: it.sku || '',
      qty: it.qty || 1,
      price: it.price || 0,
      img: it.img || ''
    }));
    const { status, statusText } = computeStatus(c.date_upd, c.order_reference);
    return {
      id: `CRW-${c.id}`,
      date: c.date_add,
      customer: c.customer_name || `Invitado web #${c.id}`,
      email: c.customer_email || 'invitado.web@mifiestashop.com',
      status, statusText, items
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const [psCarts, webCarts] = await Promise.all([
      fetchPsCarritos(),
      fetchCarritosWeb(process.env.SUPABASE_SERVICE_ROLE_KEY)
    ]);
    const carts = webCarts.concat(psCarts).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.status(200).json({ carts, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, carts: [] });
  }
};
