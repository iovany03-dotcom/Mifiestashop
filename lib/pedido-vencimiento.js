// Vigencia de los pedidos de la tienda en línea que se pagan con Mercado Pago: el pedido se crea ANTES
// de que el cliente pague (Mercado Pago necesita su folio), así que los que nunca se pagan se quedaban
// como pedidos para siempre. Aquí se cancelan cuando se vence el plazo y se regresa su stock.
//
//   - "Pendiente" y "Error en el pago" (el cliente no pagó, o lo rechazaron/expiró): PEDIDO_VIGENCIA_HORAS
//     (72 h por defecto).
//   - "Pendiente de pago" (Mercado Pago tiene un pago en proceso: OXXO, SPEI…): PEDIDO_VIGENCIA_PENDIENTE_HORAS
//     (72 h por defecto), porque esos pagos se acreditan después.
//
// Solo pedidos del checkout público con Mercado Pago (source = checkout): los pedidos manuales y los
// facturados antes de pagarse no se tocan. Antes de cancelar se consulta Mercado Pago (conciliarPedido):
// si el pago sí existe, el pedido pasa a "Pago aceptado" y no se cancela; si Mercado Pago no responde, tampoco.
const { conciliarPedido } = require('./mp-pago.js');
const historial = require('./pedido-historial.js');
const { rest, regresarStock } = require('./pedido-stock.js');

const horas = (nombre, porDefecto) => { const n = Number(process.env[nombre]); return n > 0 ? n : porDefecto; };
const vigenciaHoras = () => horas('PEDIDO_VIGENCIA_HORAS', 72);
const vigenciaPendientePagoHoras = () => horas('PEDIDO_VIGENCIA_PENDIENTE_HORAS', 72);
const SIN_PAGO = ['Pendiente', 'Pendiente de pago', 'Error en el pago'];
const SIN_PAGO_FILTRO = 'status=in.(Pendiente,%22Pendiente%20de%20pago%22,%22Error%20en%20el%20pago%22)';

async function vencerPedidosSinPago({ accessToken, serviceRoleKey, ahora = Date.now(), max = 40 }) {
  const api = rest(serviceRoleKey);
  const h1 = vigenciaHoras(), h2 = vigenciaPendientePagoHoras();
  const antes1 = new Date(ahora - h1 * 3600e3).toISOString();
  const antes2 = new Date(ahora - h2 * 3600e3).toISOString();
  const filtro = 'payment_method=eq.Mercado%20Pago&source=eq.checkout'
    + `&or=(and(status.in.(Pendiente,%22Error%20en%20el%20pago%22),created_at.lt.${antes1}),and(status.eq.%22Pendiente%20de%20pago%22,created_at.lt.${antes2}))`;
  const filas = await api(`pedidos_online?${filtro}&select=folio,status&order=created_at.asc&limit=${max}`);
  const resultados = [];
  for (const { folio } of (Array.isArray(filas) ? filas : [])) {
    try {
      await conciliarPedido({ accessToken, serviceRoleKey, folio }); // si en realidad se pagó, aquí queda "Pago aceptado"
    } catch (e) {
      resultados.push({ folio, accion: 'omitido', motivo: 'no se pudo consultar Mercado Pago' });
      continue;
    }
    const f = encodeURIComponent(folio);
    const [actual] = (await api(`pedidos_online?folio=eq.${f}&select=status`)) || [];
    if (!actual || !SIN_PAGO.includes(actual.status)) { resultados.push({ folio, accion: 'sin cambio', estado: actual ? actual.status : null }); continue; }
    // La condición de estado va en el PATCH: si el pago llegó en estos segundos, no se pisa.
    const cancelado = await api(`pedidos_online?folio=eq.${f}&${SIN_PAGO_FILTRO}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'Cancelado' })
    });
    if (!Array.isArray(cancelado) || !cancelado.length) { resultados.push({ folio, accion: 'sin cambio' }); continue; }
    const piezas = await regresarStock(api, folio, 'Sistema (pago vencido)');
    const plazo = actual.status === 'Pendiente de pago' ? h2 : h1;
    await historial.registrar(serviceRoleKey, {
      folio, origen: 'online', accion: 'cancelar', usuario: 'Sistema (pago vencido)',
      detalle: `Cancelado automáticamente: no se pagó en ${plazo} h (estaba en "${actual.status}")${piezas > 0 ? ` · se regresaron ${piezas} piezas al stock` : ''}`
    });
    resultados.push({ folio, accion: 'cancelado', piezasRegresadas: piezas });
  }
  return { revisados: resultados.length, cancelados: resultados.filter(r => r.accion === 'cancelado').length, resultados, vigenciaHoras: h1, vigenciaPendientePagoHoras: h2 };
}

module.exports = { vencerPedidosSinPago, vigenciaHoras, vigenciaPendientePagoHoras };
