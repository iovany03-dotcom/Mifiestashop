// Utilidades compartidas del stock de los pedidos en línea: descontarlo cuando el pedido se paga
// (lib/mp-pago.js) y regresarlo al cancelarlo (api/pedido-admin.js).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

function rest(key) {
  return async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  };
}

// Compensa en el ledger (pos_stock_moves) todo lo que el pedido movió de
// stock. Devuelve cuántas piezas regresó.
async function regresarStock(api, folio, registradoPor) {
  const moves = await api(`pos_stock_moves?select=id_product,almacen,qty&folio=eq.${encodeURIComponent(folio)}`);
  const net = new Map();
  (Array.isArray(moves) ? moves : []).forEach(m => {
    const key = `${m.id_product}|${m.almacen}`;
    net.set(key, (net.get(key) || 0) + Number(m.qty || 0));
  });
  const reversal = [];
  net.forEach((qty, key) => {
    if (Math.abs(qty) < 1e-9) return;
    const [id_product, almacen] = key.split('|');
    reversal.push({ id_product: Number(id_product), almacen, qty: -qty, motivo: 'cancelacion', folio, registrado_por: registradoPor || 'Admin' });
  });
  if (reversal.length) await api('pos_stock_moves', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(reversal) });
  return reversal.reduce((s, m) => s + Math.max(0, m.qty), 0);
}

// Bodega de la que sale un pedido de la tienda en línea: la sucursal elegida si es "Recoger en tienda"
// y, si no, la bodega de envíos (Rumania; se cambia con BODEGA_PEDIDOS_WEB).
function bodegaDePedido(shippingCarrier) {
  const c = String(shippingCarrier || '').toLowerCase();
  if (c.startsWith('recoger en tienda')) {
    if (c.includes('puebla')) return 'puebla';
    if (c.includes('quer')) return 'queretaro';
    if (c.includes('rumania')) return 'rumania';
  }
  const d = String(process.env.BODEGA_PEDIDOS_WEB || 'rumania').toLowerCase();
  return ['puebla', 'rumania', 'queretaro'].includes(d) ? d : 'rumania';
}

// Descuenta el stock de un pedido en línea ya pagado. No hace nada si el folio ya tiene movimientos
// (pedido manual, o pago que se notifica dos veces), así nunca descuenta doble. Devuelve las piezas.
async function descontarStock(api, folio, items, shippingCarrier, registradoPor) {
  const previos = await api(`pos_stock_moves?select=id&folio=eq.${encodeURIComponent(folio)}&limit=1`);
  if (Array.isArray(previos) && previos.length) return 0;
  const almacen = bodegaDePedido(shippingCarrier);
  const porProducto = new Map();
  (Array.isArray(items) ? items : []).forEach(i => {
    const id = Number(i && i.id), qty = Math.abs(Number(i && i.qty) || 0);
    if (id > 0 && qty > 0) porProducto.set(id, (porProducto.get(id) || 0) + qty);
  });
  const moves = [...porProducto].map(([id_product, qty]) => ({
    id_product, almacen, qty: -qty, motivo: 'venta_web', folio, registrado_por: registradoPor || 'Tienda en línea'
  }));
  if (moves.length) await api('pos_stock_moves', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(moves) });
  return moves.reduce((s, m) => s - m.qty, 0);
}

module.exports = { rest, regresarStock, descontarStock, bodegaDePedido };
