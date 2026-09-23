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

  // ?domain=clientes (uno solo) o ?domains=stock,categorias (varios), para
  // poder disparar una sincronización puntual sin esperar los 7; sin
  // parámetro corre los 7 en la misma corrida.
  //
  // El cron real (ver vercel.json) está dividido en DOS llamadas separadas,
  // cada una con su propio límite de tiempo de función serverless: sola,
  // "stock" (~82,000 filas) ya tarda más de 50s, así que en una sola corrida
  // de los 7 dominios nunca le quedaba tiempo suficiente a clientes/pedidos/
  // carritos después de ella — se estaban saltando cada hora sin avisar.
  const domain = req.query.domain;
  const domainsParam = req.query.domains;
  const domains = domainsParam
    ? String(domainsParam).split(',').map(d => d.trim()).filter(Boolean)
    : (domain ? [domain] : undefined);

  try {
    // ps_inventory_movements tiene RLS que solo permite escribir con la
    // llave de servicio real de Supabase (la de arriba, pese al nombre
    // "serviceKey", es en realidad la llave anon pública — así se llamó
    // ya desde antes en este archivo). Solo syncMovimientos la usa.
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // ?recentTarget=10000 solo aplica al dominio movimientos_recientes.
    const recentTarget = parseInt(req.query.recentTarget, 10) || undefined;
    const results = await runFullSync({ baseUrl, apiKey, supabaseUrl, serviceKey, serviceRoleKey, timeBudgetMs: 54000, domains, recentTarget });
    res.status(200).json({ ok: true, results, ranAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
