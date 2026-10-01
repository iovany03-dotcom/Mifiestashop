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
//   shipping_cost, shipping_carrier, payment_method,
//   coupon_code                     // opcional (cupones de "Retransmisiones")
// }
// -> { folio, subtotal, descuento, total, items: [{id,name,sku,price,qty}] }
//
// Con PrestaShop desconectado (default) el precio sale de catalogo_productos;
// con PRESTASHOP_CONECTADO=1 vuelve a consultarse en vivo (PS_BASE_URL, PS_API_KEY).

const { prestashopConectado, fetchPreciosActivos } = require('../lib/prestashop.js');
const { validarCupon, normalizarCodigo } = require('../lib/cupones.js');
const { enviarPushAdmins } = require('../lib/push.js');

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
    shipping_cost, shipping_carrier, payment_method, coupon_code
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

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const conectado = prestashopConectado();
  if (conectado && !apiKey) {
    res.status(200).json({ fallback: true, error: 'PS_API_KEY no configurado en Vercel' });
    return;
  }

  try {
    // PrestaShop desconectado (default, ver lib/prestashop.js): el precio
    // real sale de catalogo_productos (sincronizado desde PrestaShop cada
    // 10 min) — igual de ajeno al navegador que la consulta en vivo.
    const precios = conectado ? null : await fetchPreciosActivos(cleanItems.map(it => it.id));

    // La key va en la URL (?ws_key=), no en el header Authorization: Basic
    // — Daiscom (el proveedor) confirmó que Apache/Cloudflare eliminan ese
    // header antes de llegar al webservice, así que siempre daba 401 aunque
    // la key fuera válida y estuviera activa.

    // Vuelve a consultar el precio y nombre REALES de cada producto en
    // PrestaShop — el precio que haya mandado el navegador se descarta.
    const resolved = await Promise.all(cleanItems.map(async (it) => {
      if (!conectado) {
        const row = precios[String(it.id)];
        if (!row) return null;
        return { id: it.id, qty: it.qty, name: row.name || `Producto #${it.id}`, sku: row.sku || `PS-${it.id}`, price: Number(row.price) || 0 };
      }
      const fields = '[id,name,reference,price,active]';
      const url = `${baseUrl}/api/products/${it.id}?display=${encodeURIComponent(fields)}&output_format=JSON&ws_key=${apiKey}`;
      const r = await fetch(url);
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

    const subtotal = resolved.reduce((s, it) => s + it.price * it.qty, 0);

    // Cupón: se valida y calcula aquí con el subtotal real (lo que haya
    // calculado el navegador se ignora). Si no aplica, se avisa en vez de
    // cobrar sin el descuento que el cliente esperaba.
    let descuento = 0, cuponCodigo = null, cuponEtiqueta = null;
    if (coupon_code && String(coupon_code).trim()) {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) { res.status(400).json({ error: 'Los cupones no están disponibles en este momento. Quita el cupón para continuar.' }); return; }
      const c = await validarCupon(serviceRoleKey, coupon_code, { email: customer_email, subtotal });
      if (!c.ok) { res.status(400).json({ error: c.error, cuponInvalido: true }); return; }
      descuento = c.descuento;
      cuponCodigo = normalizarCodigo(coupon_code);
      cuponEtiqueta = `Cupón ${cuponCodigo} (${c.etiqueta})`;
    }
    const total = Math.round((subtotal - descuento + shippingCostNum) * 100) / 100;
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
      status: 'Pendiente',
      ...(cuponCodigo ? { discount_amount: descuento, discount_label: cuponEtiqueta, cupon_codigo: cuponCodigo } : {})
    };

    try {
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify(orderPayload)
      });
      // Aviso push al back office (con la app cerrada también); se espera
      // porque la función se congela al responder.
      if (ins.ok) {
        await enviarPushAdmins({
          title: '🛒 Nuevo pedido',
          body: `Pedido ${folio} de ${orderPayload.customer_name} por $${Number(total).toFixed(2)}.`,
          url: '/admin', tag: `pedido-${folio}`
        });
      }
    } catch (e) {
      // Si Supabase falla seguimos respondiendo con el pedido calculado: el
      // checkout no debe romperse por esto, igual que el resto del sitio.
    }

    res.status(200).json({ folio, subtotal, descuento, cupon: cuponCodigo, total, items: orderPayload.items });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo validar el pedido', detail: String(err) });
  }
};
