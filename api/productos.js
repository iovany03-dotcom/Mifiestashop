// Vercel serverless function: catálogo de productos, servido 100% desde
// Supabase (lib/productos-supabase.js) — PrestaShop ya no se consulta.
const { productosDesdeSupabase } = require('../lib/productos-supabase.js');

const SITE_URL = 'https://www.mifiestashop.com';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const limit = parseInt(req.query.limit, 10) || 500;
  const offset = parseInt(req.query.offset, 10) || 0;
  const category = req.query.category;
  // Modo por ids (?ids=83423,83424): devuelve solo id, precio y SKU de esos
  // productos, con el mismo cálculo que el catálogo completo. Lo usan las
  // páginas CMS para mostrar el precio real sin traer todo el catálogo.
  const idsMode = typeof req.query.ids === 'string' && req.query.ids.length > 0;
  const requestedIds = idsMode ? [...new Set(req.query.ids.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)))].slice(0, 60) : [];
  const sortKey = req.query.sort;

  await productosDesdeSupabase(req, res, { limit, offset, category, sortKey, idsMode, requestedIds, baseUrl: SITE_URL });
};
