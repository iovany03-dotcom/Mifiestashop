// Vercel Cron (cada hora, ver vercel.json "crons") — sincroniza Pedidos,
// Clientes, Carritos, Empleados, Categorías, Almacenes y Stock de
// PrestaShop hacia nuestras propias tablas en Supabase (ps_*), para que
// el resto del sitio deje de depender de la API de PrestaShop en cada
// consulta. Ver lib/sync-prestashop.js para el detalle de qué se trae de
// cada dominio y por qué (PrestaShop no permite filtrar por fecha de
// modificación, así que el diseño es: clientes aditivo, pedidos/carritos
// ventana reciente completa, el resto catálogos chicos completos.
const { runFullSync } = require('../lib/sync-prestashop.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Si se configura CRON_SECRET en Vercel, solo se acepta la llamada real
  // de Vercel Cron (que manda ese secreto) o quien lo conozca. Si no está
  // configurado, se permite sin más (igual que el resto de este proyecto
  // cuando falta una variable de entorno opcional).
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (got !== expected) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  const apiKey = process.env.PS_API_KEY;
  if (!apiKey) {
    res.status(200).json({ skipped: true, reason: 'PS_API_KEY no configurada' });
    return;
  }

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const supabaseUrl = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
  const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

  // Un solo dominio a la vez si se pide por query (?domain=clientes), para
  // poder disparar una sincronización puntual sin esperar los 7; sin
  // parámetro corre los 7 en la misma corrida (uso normal del cron).
  const domain = req.query.domain;
  const domains = domain ? [domain] : undefined;

  try {
    const results = await runFullSync({ baseUrl, apiKey, supabaseUrl, serviceKey, timeBudgetMs: 50000, domains });
    res.status(200).json({ ok: true, results, ranAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
