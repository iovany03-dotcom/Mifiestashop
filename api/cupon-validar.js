// Vercel serverless function (pública): vista previa de un cupón en el
// checkout. Solo informa; el descuento real lo vuelve a calcular
// api/crear-pedido.js con los precios del servidor.
//
// POST { codigo, email, subtotal } -> { ok, codigo, descuento, etiqueta } | { ok: false, error }
const { buscarCupon, revisarCupon, normalizarCodigo } = require('../lib/cupones.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) { res.status(200).json({ ok: false, error: 'Los cupones no están disponibles en este momento.' }); return; }

  const codigo = normalizarCodigo(body.codigo);
  if (!codigo) { res.status(200).json({ ok: false, error: 'Escribe tu código de cupón.' }); return; }
  try {
    const cupon = await buscarCupon(serviceRoleKey, codigo);
    // Al abrir el checkout desde la liga del mensaje el correo todavía
    // puede estar vacío: la vista previa no bloquea por eso (el pedido sí
    // exige el mismo correo, ver api/crear-pedido.js).
    const email = String(body.email || '').trim() || (cupon && cupon.email) || '';
    const r = revisarCupon(cupon, { email, subtotal: Number(body.subtotal) || 0 });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error }); return; }
    res.status(200).json({ ok: true, codigo, descuento: r.descuento, etiqueta: r.etiqueta, tipo: r.cupon.tipo, valor: Number(r.cupon.valor), minimo: Number(r.cupon.minimo_compra) || 0, personal: !!r.cupon.email, vence: r.cupon.vence_at || null });
  } catch (e) {
    res.status(200).json({ ok: false, error: 'No se pudo revisar el cupón. Intenta de nuevo.' });
  }
};
