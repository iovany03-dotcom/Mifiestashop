// Cupones de descuento con vigencia (tabla cupones en Supabase, solo con
// la llave de servicio). Los crea el admin en "Retransmisiones" (a mano o
// uno por cliente al mandarle un mensaje) y los usa el checkout:
// api/cupon-validar.js (vista previa) y api/crear-pedido.js (el descuento
// real, recalculado en el servidor). El uso se cuenta cuando el pedido
// queda pagado (lib/mp-pago.js), no al crearlo: si el cliente no termina de
// pagar, su cupón de un solo uso le sigue sirviendo.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const CODIGO_RE = /^[A-Z0-9-]{3,30}$/;

function normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Código al azar legible (sin 0/O ni 1/I para que no se confundan al
// dictarlo o copiarlo de un WhatsApp).
function generarCodigo(prefijo) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  const p = normalizarCodigo(prefijo).replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return p ? `${p}-${s}` : s;
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

// Descuento que da el cupón sobre el subtotal de productos (nunca sobre el
// envío, nunca más que el subtotal).
function calcularDescuento(cupon, subtotal) {
  const base = Math.max(0, Number(subtotal) || 0);
  const valor = Number(cupon.valor) || 0;
  const d = cupon.tipo === 'porcentaje' ? base * Math.min(valor, 100) / 100 : valor;
  return redondear(Math.min(d, base));
}

function etiquetaCupon(cupon) {
  const v = Number(cupon.valor) || 0;
  return cupon.tipo === 'porcentaje' ? `${v}% de descuento` : `$${v.toFixed(2)} de descuento`;
}

// Revisa si el cupón aplica. -> { ok: true, cupon, descuento, etiqueta } |
// { ok: false, error } (error con el texto que se le muestra al cliente).
function revisarCupon(cupon, { email, subtotal, ahora = new Date() }) {
  if (!cupon || !cupon.activo) return { ok: false, error: 'Ese cupón no existe o ya no está activo.' };
  if (cupon.inicia_at && new Date(cupon.inicia_at) > ahora) return { ok: false, error: 'Ese cupón todavía no está vigente.' };
  if (cupon.vence_at && new Date(cupon.vence_at) <= ahora) return { ok: false, error: 'Ese cupón ya venció.' };
  if (cupon.usos_max != null && Number(cupon.usos) >= Number(cupon.usos_max)) return { ok: false, error: 'Ese cupón ya se usó.' };
  if (cupon.email && String(email || '').trim().toLowerCase() !== String(cupon.email).trim().toLowerCase()) {
    return { ok: false, error: 'Ese cupón es personal: úsalo con el mismo correo al que te llegó.' };
  }
  const minimo = Number(cupon.minimo_compra) || 0;
  if (minimo > 0 && (Number(subtotal) || 0) < minimo) {
    return { ok: false, error: `Ese cupón aplica en compras desde $${minimo.toFixed(2)} (sin envío).` };
  }
  const descuento = calcularDescuento(cupon, subtotal);
  if (!(descuento > 0)) return { ok: false, error: 'Ese cupón no da descuento en este carrito.' };
  return { ok: true, cupon, descuento, etiqueta: etiquetaCupon(cupon) };
}

async function buscarCupon(serviceRoleKey, codigo) {
  const c = normalizarCodigo(codigo);
  if (!CODIGO_RE.test(c)) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/cupones?codigo=eq.${encodeURIComponent(c)}&select=*&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });
  if (!r.ok) throw new Error(`cupones -> HTTP ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function validarCupon(serviceRoleKey, codigo, { email, subtotal }) {
  const cupon = await buscarCupon(serviceRoleKey, codigo);
  return revisarCupon(cupon, { email, subtotal });
}

async function sumarUso(serviceRoleKey, codigo) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/cupon_sumar_uso`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_codigo: normalizarCodigo(codigo) })
  });
}

module.exports = {
  CODIGO_RE, normalizarCodigo, generarCodigo, calcularDescuento, etiquetaCupon,
  revisarCupon, buscarCupon, validarCupon, sumarUso
};
