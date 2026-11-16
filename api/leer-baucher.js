// Vercel serverless function: lee con IA el monto que aparece en la foto de un baucher o comprobante de pago
// (transferencia, voucher de tarjeta, ticket), para compararlo con el total del pedido manual en "+ Crear Pedido".
// La IA solo devuelve datos; el empleado ve y puede corregir el monto, y quien decide es él.
//
// POST { creds, image: { media_type: 'image/jpeg'|'image/png'|'image/webp', data: <base64> } }
//   -> { monto: number|null, legible, tipo, fecha, referencia } | { error }
const { exigirSesion } = require('../lib/sesion-panel.js');
const { generarJson } = require('../lib/recepcion-ia.js');

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    legible: { type: 'boolean' },
    monto: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    tipo: { type: 'string', enum: ['transferencia', 'tarjeta', 'efectivo', 'uber_lala', 'otro'] },
    fecha: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    referencia: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['legible', 'monto', 'tipo', 'fecha', 'referencia']
};

const SISTEMA = 'Lees fotos de comprobantes de pago de una tienda en México (transferencias SPEI o de apps bancarias, vouchers de terminal de tarjeta, tickets de caja). ' +
  'Devuelve el MONTO TOTAL pagado en pesos mexicanos como número (sin símbolo ni comas: 1234.50). Si hay propina o comisión, usa el total cobrado. ' +
  'Si la foto no es un comprobante de pago, está borrosa o no se distingue el monto con certeza, pon legible=false y monto=null. No inventes montos.';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  if (!(await exigirSesion(req, res))) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const img = body.image || {};
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(img.media_type) || typeof img.data !== 'string' || !img.data) {
    res.status(400).json({ error: 'Manda la foto del baucher (JPG, PNG o WEBP).' }); return;
  }
  if (img.data.length > 4 * 1024 * 1024) { res.status(413).json({ error: 'La foto es muy pesada para leerla.' }); return; }
  try {
    const d = await generarJson({
      sistema: SISTEMA, nombre: 'baucher', esquema: ESQUEMA, maxTokens: 600, esfuerzo: 'low',
      contenido: [
        { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
        { type: 'text', text: '¿Cuál es el monto total pagado en este comprobante?' }
      ]
    });
    const monto = d && d.legible && Number.isFinite(Number(d.monto)) && Number(d.monto) > 0 ? Math.round(Number(d.monto) * 100) / 100 : null;
    res.status(200).json({ monto, legible: !!(d && d.legible), tipo: d && d.tipo || 'otro', fecha: d && d.fecha || null, referencia: d && d.referencia || null });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo leer el baucher: ' + String(e.message || e).slice(0, 200) });
  }
};
