// Vercel serverless function: crea un pedido del checkout público, validando
// los precios contra PrestaShop en el servidor.
//
// Antes, el checkout calculaba el subtotal/total en el navegador a partir
// de los precios que ya traía cargados en memoria y los mandaba tal cual a
// Supabase — cualquiera con la consola del navegador abierta podía cambiar
// el precio de un artículo en el carrito antes de confirmar la compra y el
// pedido se guardaba con ese total falso, sin ninguna verificación. Este
// endpoint vuelve a consultar el precio real de cada producto en PrestaShop
// y recalcula el subtotal/total con esos valores, ignorando cualquier precio
// que haya mandado el cliente.
//
// POST /api/crear-pedido
// body: {
//   items: [{ id, qty }],           // solo id + cantidad; el precio se ignora
//   customer_name, customer_email, customer_phone,
//   address, colonia, municipio, estado, cp,
//   shipping_cost, shipping_carrier, payment_method
// }
// -> { folio, subtotal, total, items: [{id,name,sku,price,qty}] }
//
// Requires env vars: PS_BASE_URL, PS_API_KEY (mismos que el resto de /api).

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

const MAX_LINES = 50;
const MAX_QTY_PER_LINE = 999;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstLangValue(field, fallback) {
  let val = field;
  if (Array.isArray(field)) {
    val = field[0]?.value;
    if (val === undefined) val = field[0];
  } else if (field && typeof field === 'object') {
    val = field.value !== undefined ? field.value : Object.values(field)[0];
  }
  if (typeof val !== 'string' || val === '') return fallback;
  return val;
}

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
  const cleanItems = items.map(it => ({ id: Number(it?.id), qty: Number(it?.qty) }));
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

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const native = process.env.PS_NATIVE_COMMERCE === '1';
  if (!apiKey && !native) {
    res.status(200).json({ fallback: true, error: 'PS_API_KEY no configurado en Vercel' });
    return;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    // Vuelve a consultar el precio y nombre REALES de cada producto en
    // PrestaShop — el precio que haya mandado el navegador se descarta.
    const resolved = native ? await require('../lib/native-checkout').resolveItems(cleanItems) : await Promise.all(cleanItems.map(async (it) => {
      const fields = '[id,name,reference,price,active]';
      const url = `${baseUrl}/api/products/${it.id}?display=${encodeURIComponent(fields)}&output_format=JSON`;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      const data = await r.json();
      // Con display=[...campos específicos...] PrestaShop responde con la
      // clave en plural "products" (arreglo), aunque se consulte un solo ID
      // — no "product" (singular) como con display=full. Sin este fallback,
      // raw siempre salía undefined y CADA producto se marcaba como "ya no
      // disponible", bloqueando el checkout por completo.
      const raw = Array.isArray(data.products) ? data.products[0]
        : Array.isArray(data.product) ? data.product[0]
        : data.product;
      if (!raw || String(raw.active) === '0') return null;
      return {
        id: it.id,
        qty: it.qty,
        name: firstLangValue(raw.name, `Producto #${it.id}`),
        sku: raw.reference || `PS-${it.id}`,
        price: parseFloat(raw.price || 0)
      };
    }));

    if (resolved.some(r => r === null)) {
      res.status(400).json({ error: 'Uno o más productos ya no están disponibles' });
      return;
    }

    const subtotal = Math.round(resolved.reduce((s, it) => s + it.price * it.qty, 0) * 100) / 100;
    const total = Math.round((subtotal + shippingCostNum) * 100) / 100;
    const folio = 'WEB-' + require('node:crypto').randomUUID();
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
      const saved = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify(orderPayload)
      });
      if (!saved.ok) throw new Error('No se pudo guardar el pedido');
    } catch (e) {
      res.status(503).json({ error: 'No se pudo guardar el pedido. Intenta de nuevo.' });
      return;
    }

    res.status(200).json({ folio, subtotal, total, items: orderPayload.items });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo validar el pedido', detail: String(err) });
  }
};
