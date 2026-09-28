// Vercel serverless function: guarda en Supabase el carrito del sitio en
// vivo mientras el cliente compra.
//
// Antes el carrito del navegador (index.html, `cart` + saveCartToStorage)
// solo vivía en localStorage. Mientras el sitio corría sobre PrestaShop,
// "Carritos Abandonados" (panel admin, api/carritos.js) leía ps_carritos —
// carritos reales que PrestaShop guardaba en su propio servidor con cada
// "Agregar al carrito". Desde que la tienda en línea dejó de tocar
// PrestaShop en vivo (ver docs/dominio-mifiestashop-com.md), esa tabla ya
// no refleja lo que pasa en la tienda nueva: un carrito abandonado en
// mifiestashop.com ya no se guardaba en ningún lado. Este endpoint llena
// ese hueco, en una tabla propia (carritos_web) — ps_carritos se deja
// igual (sigue reflejando lo que sí pase del lado de PrestaShop, ej. POS).
//
// POST { cartKey, items:[{id,qty,name?,price?}], customerName?,
//        customerEmail?, customerPhone?, converted? }
//   cartKey: id propio del navegador (generado y guardado en localStorage
//     la primera vez que se usa el carrito) — identifica la MISMA sesión de
//     compra en visitas repetidas, para actualizar la misma fila en vez de
//     crear una nueva en cada cambio del carrito.
//   converted: folio del pedido ya creado — marca este carrito como
//     convertido (no se borra: sirve para medir conversión, igual que
//     "order_reference" en ps_carritos).
//
// Los campos de cliente son opcionales y solo se sobreescriben cuando
// vienen con valor: así una actualización posterior del carrito (ej.
// agregar otro producto ya sin el formulario de checkout abierto) no borra
// el nombre/correo/teléfono que se había capturado antes.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const MAX_ITEMS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CART_KEY_RE = /^[a-zA-Z0-9_-]{8,100}$/;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    res.status(200).json({ ok: false });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const cartKey = String(body.cartKey || '').trim();
  if (!CART_KEY_RE.test(cartKey)) {
    res.status(400).json({ error: 'cartKey inválido' });
    return;
  }

  const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const items = rawItems
    .map(it => ({
      id: parseInt(it && it.id, 10),
      qty: Math.max(1, Math.min(999, parseInt(it && it.qty, 10) || 1)),
      name: String((it && it.name) || '').slice(0, 200),
      price: Number(it && it.price) || 0
    }))
    .filter(it => Number.isFinite(it.id) && it.id > 0);

  const converted = body.converted ? String(body.converted).trim().slice(0, 40) : null;

  // Sin productos y sin marcar como convertido: nada que guardar (evita
  // filas vacías desde que se genera el cartKey, antes de agregar algo).
  if (items.length === 0 && !converted) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const row = {
    cart_key: cartKey,
    items,
    subtotal: items.reduce((s, i) => s + i.price * i.qty, 0),
    date_upd: new Date().toISOString()
  };
  const name = String(body.customerName || '').trim().slice(0, 120);
  if (name) row.customer_name = name;
  const email = String(body.customerEmail || '').trim().toLowerCase();
  if (EMAIL_RE.test(email)) row.customer_email = email;
  const phone = String(body.customerPhone || '').trim().slice(0, 40);
  if (phone) row.customer_phone = phone;
  if (converted) row.order_reference = converted;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/carritos_web?on_conflict=cart_key`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    // Guardar el carrito es secundario al resto de la compra: nunca debe
    // bloquear ni mostrar error al cliente si falla.
    res.status(200).json({ ok: false, error: err.message });
  }
};
