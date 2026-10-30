// Vercel serverless function: junta los carritos de DOS fuentes.
//
// 1) ps_carritos: el histórico de carritos que quedó de PrestaShop (ya
//    desconectado, no recibe nuevos).
// 2) carritos_web: carritos guardados en vivo por el propio sitio nuevo
//    (api/carrito-guardar.js), desde que la tienda en línea dejó de tocar
//    PrestaShop (ver docs/dominio-mifiestashop-com.md) — sin esto, un
//    carrito abandonado en mifiestashop.com no se veía en ningún lado.
//
// El estado (activo/abandonado/convertido) se calcula aquí, en cada
// lectura, a partir de la fecha de actualización y de si tiene folio de
// pedido — no se guarda estático, porque "abandonado" depende de cuánto
// tiempo ha pasado, no de un valor fijo.
const { exigirSesion } = require('../lib/sesion-panel.js');
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

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
  const r = await fetch(url, { headers: { apikey: LLAVE_SERVICIO(), Authorization: `Bearer ${LLAVE_SERVICIO()}` } });
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

// Pedidos de la tienda con Mercado Pago que nadie ha pagado (Pendiente / Error en el pago): se muestran
// aquí como carritos en vez de como pedidos; al pagarse pasan a Pedidos (api/pedidos-online.js).
async function fetchSinPago(serviceRoleKey) {
  if (!serviceRoleKey) return [];
  const url = `${SUPABASE_URL}/rest/v1/pedidos_online?select=folio,created_at,customer_name,customer_email,items,status&source=eq.checkout&payment_method=eq.Mercado%20Pago&status=in.(Pendiente,%22Error%20en%20el%20pago%22)&order=created_at.desc&limit=500`;
  const r = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
  if (!r.ok) throw new Error(`Supabase error ${r.status}`);
  return r.json();
}

async function fetchCarritosWeb(serviceRoleKey, sinPago = []) {
  if (!serviceRoleKey) return [];
  const foliosSinPago = new Set(sinPago.map(p => p.folio));
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
    // Si el carrito llegó a crear un pedido que nunca se pagó, sigue siendo un carrito.
    const sinPagar = c.order_reference && foliosSinPago.has(c.order_reference);
    const calc = computeStatus(c.date_upd, sinPagar ? null : c.order_reference);
    const status = calc.status;
    const statusText = sinPagar ? `${calc.statusText} · pago pendiente (${c.order_reference})` : calc.statusText;
    return {
      id: `CRW-${c.id}`,
      date: c.date_add,
      customer: c.customer_name || `Invitado web #${c.id}`,
      email: c.customer_email || 'invitado.web@mifiestashop.com',
      status, statusText, items, ...(sinPagar ? { folioSinPago: c.order_reference } : {})
    };
  });
}

const LLAVE_SERVICIO = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
module.exports = async function handler(req, res) {
  // Datos privados del panel: solo con sesión (lib/sesion-panel.js) y nunca en la caché del CDN.
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await exigirSesion(req, res))) return;

  try {
    const sinPago = await fetchSinPago(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const [psCarts, webCarts] = await Promise.all([
      fetchPsCarritos(),
      fetchCarritosWeb(process.env.SUPABASE_SERVICE_ROLE_KEY, sinPago)
    ]);
    // Pedidos sin pagar cuyo carrito no se guardó aparte (si se guardó, ya salió arriba con su folio).
    const yaListados = new Set(webCarts.map(w => w.folioSinPago).filter(Boolean));
    const deSinPago = sinPago.filter(p => !yaListados.has(p.folio)).map(p => {
      const calc = computeStatus(p.created_at, null);
      return {
        id: `PED-${p.folio}`, date: p.created_at,
        customer: p.customer_name || 'Invitado web', email: p.customer_email || 'invitado.web@mifiestashop.com',
        status: calc.status, statusText: `${calc.statusText} · pago pendiente (${p.folio})`,
        items: (Array.isArray(p.items) ? p.items : []).map(it => ({ name: it.name || `Producto #${it.id}`, sku: it.sku || '', qty: it.qty || 1, price: it.price || 0, img: it.img || '' }))
      };
    });
    const carts = webCarts.map(({ folioSinPago, ...w }) => w).concat(deSinPago, psCarts).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.status(200).json({ carts, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ fallback: true, error: err.message, carts: [] });
  }
};
