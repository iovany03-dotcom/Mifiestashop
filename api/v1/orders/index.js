// API pública /api/v1/orders
// GET  scope orders:read  — lista pedidos creados desde checkout/API (pedidos_online)
// POST scope orders:write — crea un pedido, revalidando precios en vivo
// contra PrestaShop (igual que el checkout público real — nunca se confía
// en el precio que mande quien llama a la API).
const { authenticateApiRequest, sendApiError } = require('../../../lib/api-auth.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const MAX_LINES = 50;
const MAX_QTY_PER_LINE = 999;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstLangValue(field, fallback) {
  let val = field;
  if (Array.isArray(field)) { val = field[0]?.value; if (val === undefined) val = field[0]; }
  else if (field && typeof field === 'object') { val = field.value !== undefined ? field.value : Object.values(field)[0]; }
  if (typeof val !== 'string' || val === '') return fallback;
  return val;
}

function toPublicOrder(o) {
  return {
    id: Number(o.id), folio: o.folio, created_at: o.created_at, status: o.status,
    customer_name: o.customer_name, customer_email: o.customer_email, customer_phone: o.customer_phone,
    shipping_address: o.shipping_address, shipping_cost: o.shipping_cost !== null ? Number(o.shipping_cost) : undefined,
    payment_method: o.payment_method || undefined,
    items: Array.isArray(o.items) ? o.items : [],
    subtotal: Number(o.subtotal), total: Number(o.total)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    const auth = await authenticateApiRequest(req, 'orders:read');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return sendApiError(res, 500, 'SUPABASE_SERVICE_ROLE_KEY no configurado en Vercel.', 'not_configured');
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
      const select = 'id,folio,created_at,status,customer_name,customer_email,customer_phone,shipping_address,shipping_cost,payment_method,items,subtotal,total';
      const url = `${SUPABASE_URL}/rest/v1/pedidos_online?select=${select}&order=created_at.desc&limit=${limit}&offset=${offset}`;
      const r = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Prefer: 'count=exact' } });
      if (!r.ok) return sendApiError(res, 502, 'No se pudieron consultar los pedidos.', 'upstream_error');
      const rows = await r.json();
      const range = r.headers.get('content-range');
      const total = range && range.includes('/') ? parseInt(range.split('/')[1], 10) : rows.length;
      res.status(200).json({ data: rows.map(toPublicOrder), meta: { total: Number.isFinite(total) ? total : rows.length, limit, offset } });
    } catch (err) {
      sendApiError(res, 500, 'Error al consultar pedidos: ' + err.message, 'internal_error');
    }
    return;
  }

  if (req.method === 'POST') {
    const auth = await authenticateApiRequest(req, 'orders:write');
    if (!auth.ok) return sendApiError(res, auth.status, auth.error);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { items, customer_name, customer_email, customer_phone, shipping_address, shipping_cost, payment_method } = body;

    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) {
      return sendApiError(res, 422, `"items" debe ser un arreglo de 1 a ${MAX_LINES} elementos {id, qty}.`, 'invalid_items');
    }
    const cleanItems = items.map(it => ({ id: parseInt(it.id, 10), qty: parseInt(it.qty, 10) }));
    if (cleanItems.some(it => !Number.isInteger(it.id) || it.id <= 0 || !Number.isInteger(it.qty) || it.qty <= 0 || it.qty > MAX_QTY_PER_LINE)) {
      return sendApiError(res, 422, 'Cada item necesita un id y qty (cantidad) válidos.', 'invalid_items');
    }
    if (!customer_name || !customer_email || !EMAIL_RE.test(customer_email) || !customer_phone || !shipping_address) {
      return sendApiError(res, 422, 'Faltan datos de contacto o envío (customer_name, customer_email, customer_phone, shipping_address).', 'missing_fields');
    }
    const shippingCostNum = Number(shipping_cost || 0);
    if (!Number.isFinite(shippingCostNum) || shippingCostNum < 0) {
      return sendApiError(res, 422, 'shipping_cost inválido.', 'invalid_shipping_cost');
    }

    const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
    const apiKey = process.env.PS_API_KEY;
    if (!apiKey) return sendApiError(res, 500, 'PS_API_KEY no configurado en Vercel.', 'not_configured');

    try {
      const headers = { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` };
      // Igual que el checkout público: el precio SIEMPRE se vuelve a
      // consultar en vivo en PrestaShop, nunca se confía en el que mande
      // quien llama a la API.
      const resolved = await Promise.all(cleanItems.map(async (it) => {
        const fields = '[id,name,reference,price,active]';
        const url = `${baseUrl}/api/products/${it.id}?display=${encodeURIComponent(fields)}&output_format=JSON`;
        const r = await fetch(url, { headers });
        if (!r.ok) return null;
        const data = await r.json();
        const raw = Array.isArray(data.products) ? data.products[0] : Array.isArray(data.product) ? data.product[0] : data.product;
        if (!raw || String(raw.active) === '0') return null;
        return { id: it.id, qty: it.qty, name: firstLangValue(raw.name, `Producto #${it.id}`), sku: raw.reference || `PS-${it.id}`, price: parseFloat(raw.price || 0) };
      }));
      if (resolved.some(r => r === null)) {
        return sendApiError(res, 422, 'Uno o más productos ya no están disponibles.', 'product_unavailable');
      }

      const subtotal = resolved.reduce((s, it) => s + it.price * it.qty, 0);
      const total = subtotal + shippingCostNum;
      const folio = 'API-' + Date.now().toString().slice(-6);

      const orderPayload = {
        folio,
        customer_name: String(customer_name).slice(0, 200),
        customer_email: String(customer_email).slice(0, 200),
        customer_phone: String(customer_phone).slice(0, 40),
        shipping_address: String(shipping_address).slice(0, 500),
        shipping_cost: shippingCostNum,
        payment_method: payment_method ? String(payment_method).slice(0, 40) : '',
        items: resolved.map(({ id, name, sku, price, qty }) => ({ id, name, sku, price, qty })),
        subtotal, total, status: 'Pendiente', source: 'api', created_by: auth.key.nombre
      };

      const r = await fetch(`${SUPABASE_URL}/rest/v1/pedidos_online`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(orderPayload)
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return sendApiError(res, 502, 'No se pudo guardar el pedido: ' + text.slice(0, 300), 'upstream_error');
      }
      const saved = await r.json();
      const s = Array.isArray(saved) ? saved[0] : saved;
      res.status(201).json({ data: toPublicOrder(s) });
    } catch (err) {
      sendApiError(res, 500, 'Error al crear el pedido: ' + err.message, 'internal_error');
    }
    return;
  }

  sendApiError(res, 405, 'Método no permitido. Usa GET o POST.', 'method_not_allowed');
};
