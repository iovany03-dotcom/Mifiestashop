// Vercel serverless function: real per-warehouse (sucursal) stock for a product,
// used by the public product page to show "existencia por sucursal".
const { prestashopConectado, sbGetAll } = require('../lib/prestashop.js');

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

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  const id = req.query.id;

  if (!id) {
    res.status(400).json({ error: 'Falta parámetro id' });
    return;
  }
  // PrestaShop desconectado (default, ver lib/prestashop.js): existencias de
  // ps_stock, la copia que el cron sincroniza cada hora desde PrestaShop
  // (mismo dato: usable_quantity por almacén).
  if (!prestashopConectado()) {
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
    return;
  }

  if (!apiKey) {
    res.status(200).json({ fallback: true, branches: [], total: 0 });
    return;
  }

  try {
    // La key va en la URL (?ws_key=), no en el header Authorization: Basic
    // — Daiscom (el proveedor) confirmó que Apache/Cloudflare eliminan ese
    // header antes de llegar al webservice, así que siempre daba 401 aunque
    // la key fuera válida y estuviera activa.
    const fields = '[id_warehouse,usable_quantity]';
    const url = `${baseUrl}/api/stocks?filter[id_product]=${id}&display=${encodeURIComponent(fields)}&limit=0,50&output_format=JSON&ws_key=${apiKey}`;
    const r = await fetch(url);

    if (!r.ok) {
      res.status(200).json({ branches: [], total: 0 });
      return;
    }

    const data = await r.json();
    const rows = (Array.isArray(data.stocks) ? data.stocks : [])
      .filter(s => !HIDDEN_WAREHOUSES.includes(String(s.id_warehouse)));

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
