// Vercel serverless function: crea un pedido del checkout público, validando
// los precios contra el catálogo real en el servidor.
//
// Antes, el checkout calculaba el subtotal/total en el navegador a partir
// de los precios que ya traía cargados en memoria y los mandaba tal cual a
// Supabase — cualquiera con la consola del navegador abierta podía cambiar
// el precio de un artículo en el carrito antes de confirmar la compra y el
// pedido se guardaba con ese total falso, sin ninguna verificación. Este
// endpoint vuelve a consultar el precio real de cada producto en
// catalogo_productos (Supabase) y recalcula el subtotal/total con esos
// valores, ignorando cualquier precio que haya mandado el cliente. Antes
// consultaba PrestaShop en vivo por cada línea; se cambió porque
// PrestaShop se está dando de baja — ver lib/sync-prestashop.js (dominio
// "productos") y api/guardar-producto.js.
//
// POST /api/crear-pedido
// body: {
//   items: [{ id, qty }],           // solo id + cantidad; el precio se ignora
//   customer_name, customer_email, customer_phone,
//   address, colonia, municipio, estado, cp,
//   shipping_cost, shipping_carrier, payment_method
// }
// -> { folio, subtotal, total, items: [{id,name,sku,price,qty}] }

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

const MAX_LINES = 50;
const MAX_QTY_PER_LINE = 999;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const {
    items, customer_name, customer_email, customer_phone,
    address, colonia, municipio, estado, cp,
    shipping_cost, shipping_carrier, payment_method
  } = body;

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) {
    res.status(400).json({ error: 'Carrito inválido' });
    return;
  }
  const cleanItems = items.map(it => ({ id: parseInt(it.id, 10), qty: parseInt(it.qty, 10) }));
  if (cleanItems.some(it => !Number.isInteger(it.id) || it.id <= 0 || !Number.isInteger(it.qty) || it.qty <= 0 || it.qty > MAX_QTY_PER_LINE)) {
    res.status(400).json({ error: 'Artículo o cantidad inválida en el carrito' });
    return;
  }
  if (!customer_name || !customer_email || !EMAIL_RE.test(customer_email) || !customer_phone || !address || !colonia || !municipio || !estado || !cp) {
    res.status(400).json({ error: 'Faltan datos de contacto o envío' });
    return;
  }
  const shippingCostNum = Number(shipping_cost);
  if (!Number.isFinite(shippingCostNum) || shippingCostNum < 0) {
    res.status(400).json({ error: 'Costo de envío inválido' });
    return;
  }

  try {
    // Vuelve a consultar el precio y nombre REALES de cada producto en
    // catalogo_productos (Supabase) — el precio que haya mandado el
    // navegador se descarta. Antes esto consultaba PrestaShop en vivo por
    // cada línea del carrito; PrestaShop se está dando de baja, así que la
    // verificación pasa a catalogo_productos (llenada por el sync horario
    // mientras PrestaShop siga arriba, y editable desde el admin en
    // adelante — ver api/guardar-producto.js).
    const ids = cleanItems.map(it => it.id);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/catalogo_productos?select=id,name,sku,price,active&id=in.(${ids.join(',')})`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!r.ok) {
      res.status(502).json({ error: 'No se pudo verificar el catálogo' });
      return;
    }
    const rows = await r.json();
    const byId = new Map((Array.isArray(rows) ? rows : []).map(row => [Number(row.id), row]));

    const resolved = cleanItems.map(it => {
      const raw = byId.get(it.id);
      if (!raw || raw.active === false) return null;
      return {
        id: it.id,
        qty: it.qty,
        name: raw.name || `Producto #${it.id}`,
        sku: raw.sku || `PS-${it.id}`,
        price: parseFloat(raw.price || 0)
      };
    });

    if (resolved.some(it => it === null)) {
      res.status(400).json({ error: 'Uno o más productos ya no están disponibles' });
      return;
    }

    const subtotal = resolved.reduce((s, it) => s + it.price * it.qty, 0);
    const total = subtotal + shippingCostNum;
    const folio = 'WEB-' + Date.now().toString().slice(-6);
    const fullAddress = `${address}, Col. ${colonia}, ${municipio}, ${estado}, CP ${cp}`;

    const orderPayload = {
      folio,
      customer_name: String(customer_name).slice(0, 200),
      customer_email,
      customer_phone: String(customer_phone).slice(0, 40),
      shipping_address: fullAddress,
      shipping_cp: String(cp).slice(0, 10),
      shipping_cost: shippingCostNum,
      shipping_carrier: shipping_carrier ? String(shipping_carrier).slice(0, 100) : '',
      payment_method: payment_method ? String(payment_method).slice(0, 40) : '',
      items: resolved.map(({ id, name, sku, price, qty }) => ({ id, name, sku, price, qty })),
      subtotal,
      total,
      status: 'Pendiente'
    };

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify(orderPayload)
      });
    } catch (e) {
      // Si Supabase falla seguimos respondiendo con el pedido calculado: el
      // checkout no debe romperse por esto, igual que el resto del sitio.
    }

    res.status(200).json({ folio, subtotal, total, items: orderPayload.items });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo validar el pedido', detail: String(err) });
  }
};
