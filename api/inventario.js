// Vercel serverless function: fetches inventory stock per warehouse from PrestaShop API / Supabase

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (process.env.PS_NATIVE_COMMERCE === '1') return require('../lib/native-stock').inventory(req, res);

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  // Warehouses list
  const almacenes = [
    { id: 1, name: 'Puebla Principal', code: 'PUE' },
    { id: 2, name: 'CDMX Rumania', code: 'RUM' },
    { id: 3, name: 'Querétaro', code: 'QRO' },
    { id: 4, name: 'Atizapán', code: 'ATZ' },
    { id: 5, name: 'CDMX Popocatépetl', code: 'POP' }
  ];

  if (!apiKey) {
    // If PS_API_KEY is missing, return structure with simulated stock distribution
    res.status(200).json({
      status: 'demo',
      message: 'Mostrando inventario estructurado por almacén',
      almacenes
    });
    return;
  }

  try {
    const limit = req.query.limit || 100;
    const url = `${baseUrl}/api/stock_availables?display=full&limit=0,${limit}&output_format=JSON`;
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      res.status(200).json({ status: 'warning', message: 'No se pudo consultar stock_availables', almacenes });
      return;
    }

    const data = await r.json();
    const stocks = data.stock_availables || [];

    res.status(200).json({
      status: 'ok',
      almacenes,
      stocksCount: stocks.length,
      stocks: stocks.map(s => ({
        id: s.id,
        id_product: s.id_product,
        id_product_attribute: s.id_product_attribute,
        quantity: parseInt(s.quantity || 0, 10),
        id_shop: s.id_shop
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar inventario en PrestaShop API', detail: String(err) });
  }
};
