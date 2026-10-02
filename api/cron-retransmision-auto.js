// Vercel Cron (ver vercel.json, cada hora): manda sola la plantilla de WhatsApp (con o sin
// cupón) a quien lleva más de "horas_espera" desde que abandonó su carrito/pedido sin pagar —
// sin que nadie en el admin tenga que entrar a "Retransmisiones" y seleccionarlo a mano.
// Config real en ajustes_retransmision_auto (ver 'auto_config_leer'/'auto_config_guardar' en
// api/retransmisiones.js, pestaña "Automático"). Reusa exactamente audiencia()/enviar() de ese
// mismo archivo — este cron solo decide A QUIÉN, usando el mismo envío real (chatbotproia) que
// ya usa el botón manual.
const { audiencia, enviar, sb, telefonoWhatsApp } = require('./retransmisiones.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Mismo criterio que api/cron-sync-prestashop.js: con CRON_SECRET, solo Vercel Cron (o quien
  // lo conozca).
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (got !== expected) { res.status(401).json({ error: 'unauthorized' }); return; }
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const db = sb(key);

  try {
    const configRows = await db.get('ajustes_retransmision_auto?select=*&order=id.desc&limit=1');
    const config = configRows[0];
    if (!config || !config.activo) {
      res.status(200).json({ ok: true, activo: false, enviados: 0 });
      return;
    }
    if (!config.plantilla_nombre || !config.plantilla_idioma) {
      res.status(200).json({ ok: true, activo: true, enviados: 0, motivo: 'sin plantilla configurada' });
      return;
    }

    const candidatos = await audiencia(db, config.dias_buscar);
    // Nunca se le manda dos veces por WhatsApp a la misma referencia (ni lo pise un envío
    // manual que ya le haya hecho el staff) — se revisa contra TODO el historial, sin importar
    // si salió bien o con error, para no insistirle a quien ya se le intentó.
    const yaContactados = new Set(
      (await db.get('retransmisiones?canal=eq.whatsapp&select=referencia')).map(r => r.referencia)
    );
    const limiteMs = config.horas_espera * 36e5;
    const ahora = Date.now();
    const listos = candidatos.filter(d =>
      telefonoWhatsApp(d.telefono) &&
      !yaContactados.has(d.referencia) &&
      (ahora - new Date(d.fecha).getTime()) >= limiteMs
    );

    if (!listos.length) {
      res.status(200).json({ ok: true, activo: true, enviados: 0, candidatos: candidatos.length });
      return;
    }

    const resultados = await enviar(db, {
      canal: 'whatsapp',
      destinatarios: listos.map(d => ({ tipo: d.tipo, referencia: d.referencia })),
      mensaje: 'Hola {nombre}, vimos que dejaste artículos en tu carrito de Mi Fiestashop.', // solo queda en el historial; lo que de verdad se manda es la plantilla.
      cupon: config.cupon_tipo === 'existente'
        ? { modo: 'existente', codigo: config.cupon_codigo }
        : config.cupon_tipo
          ? { modo: 'personal', tipo: config.cupon_tipo, valor: config.cupon_valor, minimo: config.cupon_minimo, horas: config.cupon_vigencia_horas, prefijo: config.cupon_prefijo }
          : { modo: 'ninguno' },
      plantillaWa: { name: config.plantilla_nombre, language: config.plantilla_idioma, mapping: config.plantilla_mapping || [] }
    }, 'Automático (programado)');

    res.status(200).json({
      ok: true, activo: true, enviados: resultados.filter(r => r.ok).length, total: resultados.length,
      errores: resultados.filter(r => !r.ok).map(r => ({ referencia: r.referencia, error: r.error }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
