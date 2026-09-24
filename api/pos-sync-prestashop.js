// Vercel serverless function: antes creaba el pedido correspondiente EN
// PRESTASHOP (carrito -> pedido -> líneas de pedido) y descontaba su propio
// stock cuando se cerraba un ticket en el Sistema POS.
//
// Se desactiva: PrestaShop se está dando de baja. El ledger de Supabase
// (pos_stock_moves) ya era el registro resiliente desde el principio (el
// ticket y el descuento ahí siempre se guardaban primero — ver
// confirmPOSSale en index.html, que ya no llama a este endpoint); esto solo
// era un espejo best-effort adicional hacia PrestaShop, ahora imposible.
// Se deja el archivo como stub en vez de borrarlo por si algo externo
// todavía le pega directo.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, skipped: true, reason: 'PrestaShop dado de baja: el ledger de Supabase es el único registro.' });
};
