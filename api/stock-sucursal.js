// Vercel serverless function: real per-warehouse (sucursal) stock for a product,
// used by the public product page to show "existencia por sucursal".
const { sbGetAll } = require('../lib/catalogo-supabase.js');

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

  if (!id) {
    res.status(400).json({ error: 'Falta parámetro id' });
    return;
  }
  // Existencias de ps_stock (usable_quantity por almacén).
  if (!/^\d+$/.test(String(id))) {
    res.status(400).json({ error: 'id inválido' });
    return;
  }
  try {
    const rows = (await sbGetAll(`ps_stock?select=id_warehouse,quantity&id_product=eq.${id}&order=id_warehouse.asc`))
      .filter(s => !HIDDEN_WAREHOUSES.includes(String(s.id_warehouse)));
    const branches = rows.map(s => ({
      warehouseId: String(s.id_warehouse),
      name: WAREHOUSES[String(s.id_warehouse)] || `Almacén ${s.id_warehouse}`,
      qty: Math.round(Number(s.quantity) || 0)
    }));
    res.status(200).json({ branches, total: branches.reduce((sum, b) => sum + b.qty, 0) });
  } catch (err) {
    res.status(200).json({ error: err.message, branches: [], total: 0 });
  }
};
