// Vercel serverless function: real per-warehouse (sucursal) stock for a product,
// used by the public product page to show "existencia por sucursal".
//
// Antes consultaba PrestaShop en vivo (/api/stocks) en cada carga de la
// página de producto. PrestaShop se está dando de baja — se lee ps_stock
// (Supabase), sincronizado cada hora por lib/sync-prestashop.js mientras
// PrestaShop siga arriba, y congelado con el último dato bueno después.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

const WAREHOUSES = {
  '53': 'CDMX Rumania',
  '54': 'CDMX Popocatépetl',
  '55': 'Puebla',
  '56': 'Querétaro',
  '57': 'Guadalajara',
  '58': 'Atizapán'
};

// Sucursales que ya no deben mostrarse en "Existencia por sucursal" del sitio público.
const HIDDEN_WAREHOUSES = ['54', '58'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const id = req.query.id;
  if (!id || !/^\d+$/.test(String(id))) {
    res.status(400).json({ error: 'Falta parámetro id' });
    return;
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ps_stock?select=id_warehouse,quantity&id_product=eq.${id}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!r.ok) {
      res.status(200).json({ branches: [], total: 0 });
      return;
    }

    const rows = (await r.json())
      .filter(s => !HIDDEN_WAREHOUSES.includes(String(s.id_warehouse)));

    const branches = rows.map(s => ({
      warehouseId: s.id_warehouse,
      name: WAREHOUSES[String(s.id_warehouse)] || `Almacén ${s.id_warehouse}`,
      qty: Math.round(parseFloat(s.quantity || 0))
    }));

    const total = branches.reduce((sum, b) => sum + b.qty, 0);

    res.status(200).json({ branches, total });
  } catch (err) {
    res.status(200).json({ error: err.message, branches: [], total: 0 });
  }
};
