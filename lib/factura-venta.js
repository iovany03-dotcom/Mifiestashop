// Venta (pedido de la tienda o ticket del POS) tal como se factura: la usan el panel
// (api/facturama.js) y la autofactura de los clientes (api/autofactura.js).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';

function sb(serviceKey) {
  return async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
}

const PAGADOS = ['Pago aceptado', 'Pagado', 'En preparación', 'Enviado', 'Entregado'];
// Estado que permite facturar un pedido todavía no pagado. La factura sale como pago diferido (PPD, forma 99).
const ANTICIPADA = 'Factura anticipada';
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// "#POS-123", "pos-123" -> origen pos, folio "#POS-123"; cualquier otro -> pedido de la tienda.
function normalizarVenta(origen, folio) {
  let f = String(folio || '').trim().toUpperCase().replace(/\s+/g, '');
  const esPos = origen === 'pos' || (!origen && /^#?POS-/.test(f));
  if (esPos && /^POS-/.test(f)) f = '#' + f;
  return { origen: esPos ? 'pos' : 'online', folio: f };
}

// El pedido/ticket tal como se va a facturar: conceptos (con el envío como concepto aparte y
// el descuento del cupón repartido entre los productos), y si se puede facturar.
async function cargarVenta(api, origenPedido, folioPedido) {
  const { origen, folio } = normalizarVenta(origenPedido, folioPedido);
  if (!folio || folio.length > 60) return { error: 'Folio inválido.', status: 400 };
  const tabla = origen === 'online' ? 'pedidos_online' : 'pos_tickets';
  const rows = await api(`${tabla}?folio=eq.${encodeURIComponent(folio)}&select=*&limit=1`);
  const p = rows && rows[0];
  if (!p) return { error: origen === 'pos' ? `No existe el ticket ${folio} en el POS.` : `No existe el pedido ${folio} en la tienda.`, status: 404 };

  const conceptos = (Array.isArray(p.items) ? p.items : []).map(it => {
    const sku = String(it.sku || '').trim();
    return {
      id: it.id || it.product_id || null,
      name: String(it.name || 'Producto'),
      // El "SKU" del catálogo suele ser una lista de palabras clave: si no es un código corto
      // se usa el id del producto.
      sku: sku && sku.length <= 30 && !/[,\s]/.test(sku) ? sku : String(it.id || it.product_id || ''),
      qty: Number(it.qty) || 1,
      price: Number(it.price) || 0
    };
  }).filter(c => c.qty > 0 && c.price > 0);

  // Ticket del POS con "Aplicar IVA": el POS suma el 16% encima de los precios de los productos
  // (subtotal + IVA = total), o sea que esos precios NO traen IVA. Para que la factura quede con
  // el subtotal de los productos, el IVA del ticket y el total cobrado, se pasan a "con IVA"
  // (el resto del sistema asume precios con IVA incluido) antes de desglosarlos.
  const subtotalTicket = Number(p.subtotal), ivaTicket = Number(p.iva), totalTicket = Number(p.total);
  if (origen === 'pos' && process.env.FACTURAMA_IVA_INCLUIDO !== '0' && ivaTicket > 0
      && Math.abs(subtotalTicket + ivaTicket - totalTicket) <= 1) {
    conceptos.forEach(c => { c.price = c.price * 1.16; });
  }

  // Pedido manual con "Aplicar IVA" (panel → Crear pedido): igual que en el POS, el 16% se suma encima de
  // los precios de los productos ((subtotal - descuento) × 1.16 + envío = total); el envío no lleva IVA
  // aparte. Esos precios y su descuento van sin IVA, así que se pasan a "con IVA" antes de desglosar.
  let factorIva = 1;
  if (origen === 'online' && p.source === 'manual' && process.env.FACTURAMA_IVA_INCLUIDO !== '0') {
    const base = (Number(p.subtotal) || 0) - (Number(p.discount_amount) || 0);
    if (base > 0 && Math.abs(base * 1.16 + (Number(p.shipping_cost) || 0) - Number(p.total)) <= 1) {
      factorIva = 1.16;
      conceptos.forEach(c => { c.price = c.price * factorIva; });
    }
  }

  // Cupón / descuento del pedido repartido proporcionalmente (el último renglón se lleva el ajuste de centavos).
  const descuento = r2((Number(p.discount_amount) || 0) * factorIva);
  if (descuento > 0 && conceptos.length) {
    const brutoTotal = conceptos.reduce((s, c) => s + c.price * c.qty, 0);
    let repartido = 0;
    conceptos.forEach((c, i) => {
      const d = i === conceptos.length - 1 ? r2(descuento - repartido) : r2(descuento * (c.price * c.qty) / brutoTotal);
      c.descuento = d; repartido = r2(repartido + d);
    });
  }
  const envio = r2(Number(p.shipping_cost) || 0);
  if (origen === 'online' && envio > 0) {
    conceptos.push({ name: `Envío${p.shipping_carrier ? ' (' + p.shipping_carrier + ')' : ''}`, sku: 'ENVIO', qty: 1, price: envio, claveSat: '78102203', unidad: 'Servicio', claveUnidad: 'E48' });
  }

  const total = r2(Number(p.total) || 0);
  const totalConceptos = r2(conceptos.reduce((s, c) => s + c.price * c.qty - (c.descuento || 0), 0));
  const estado = origen === 'online' ? (p.status || 'Pendiente') : (p.estado || 'Cobrado');
  let motivo = null;
  if (origen === 'online' && !PAGADOS.includes(estado) && estado !== ANTICIPADA) motivo = `El pedido ${folio} está "${estado}": solo se facturan pedidos pagados o en estado "${ANTICIPADA}".`;
  else if (origen === 'pos' && /cancel/i.test(estado)) motivo = `El ticket ${folio} está cancelado.`;
  else if (!conceptos.length) motivo = `El ${origen === 'pos' ? 'ticket' : 'pedido'} ${folio} no tiene productos con precio.`;
  else if (Math.abs(totalConceptos - total) > 1) motivo = `Los productos del ${origen === 'pos' ? 'ticket' : 'pedido'} suman $${totalConceptos.toFixed(2)} pero su total es $${total.toFixed(2)}; corrige el ${origen === 'pos' ? 'ticket' : 'pedido'} antes de facturarlo.`;

  return {
    venta: {
      origen, folio, total, estado, conceptos, totalConceptos,
      email: p.customer_email || null, nombre: p.customer_name || p.cliente || null,
      fecha: p.created_at || null, facturable: !motivo, motivo
    }
  };
}

// Folio único por operación: se guarda en la factura y se manda a Facturama (idempotencia).
const nuevoFolio = () => String(Date.now()).slice(-9);
// Fecha del CFDI en hora de México, sin zona (formato de Facturama), 2 minutos atrás por el desfase del SAT.
function fechaMx() {
  const d = new Date(Date.now() - 2 * 60 * 1000);
  return d.toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).replace(' ', 'T');
}

module.exports = { sb, cargarVenta, normalizarVenta, nuevoFolio, fechaMx, PAGADOS, ANTICIPADA, r2 };
