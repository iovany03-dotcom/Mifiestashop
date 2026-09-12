// Vercel serverless function: real per-warehouse (sucursal) stock for a product,
// used by the public product page to show "existencia por sucursal".
const WAREHOUSES = {
  '53': 'CDMX Rumania',
  '54': 'CDMX Popocatépetl',
  '55': 'Puebla',
  '56': 'Querétaro',
  '57': 'Guadalajara',
  '58': 'Atizapán'
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const id = req.query.id;

  if (!id) {
    res.status(400).json({ error: 'Falta parámetro id' });
    return;
  }
  if (!apiKey) {
    res.status(200).json({ fallback: true, branches: [], total: 0 });
    return;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const fields = '[id_warehouse,usable_quantity]';
    const url = `${baseUrl}/api/stocks?filter[id_product]=${id}&display=${encodeURIComponent(fields)}&limit=0,50&output_format=JSON`;
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

    if (!r.ok) {
      res.status(200).json({ branches: [], total: 0 });
      return;
    }

    const data = await r.json();
    const rows = Array.isArray(data.stocks) ? data.stocks : [];

    const branches = rows.map(s => ({
      warehouseId: s.id_warehouse,
      name: WAREHOUSES[s.id_warehouse] || `Almacén ${s.id_warehouse}`,
      qty: Math.round(parseFloat(s.usable_quantity || 0))
    }));

    const total = branches.reduce((sum, b) => sum + b.qty, 0);

    res.status(200).json({ branches, total });
  } catch (err) {
    res.status(200).json({ error: err.message, branches: [], total: 0 });
  }
};
