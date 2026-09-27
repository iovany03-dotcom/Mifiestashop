// Vercel serverless function: fetches inventory stock per warehouse from PrestaShop API / Supabase
const { prestashopConectado, sbGetAll, fetchCatalogoActivo } = require('../lib/prestashop.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

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

  // PrestaShop desconectado (default, ver lib/prestashop.js): existencias
  // desde ps_stock (sincronizado cada hora), sumadas por producto.
  if (!prestashopConectado()) {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 5000);
      // Solo productos activos del catálogo (ps_stock trae ~80,000 filas,
      // incluidas las de productos inactivos): los primeros `limit`.
      const ids = (await fetchCatalogoActivo('id')).slice(0, limit).map(r => r.id);
      const byProduct = new Map(ids.map(id => [id, 0]));
      for (let i = 0; i < ids.length; i += 200) {
        (await sbGetAll(`ps_stock?select=id_product,quantity&id_product=in.(${ids.slice(i, i + 200).join(',')})`))
          .forEach(s => byProduct.set(s.id_product, (byProduct.get(s.id_product) || 0) + (Number(s.quantity) || 0)));
      }
      const stocks = [...byProduct.entries()].map(([idProduct, qty]) => ({
        id: idProduct, id_product: String(idProduct), id_product_attribute: '0', quantity: Math.round(qty), id_shop: '1'
      }));
      res.status(200).json({ status: 'ok', source: 'supabase', almacenes, stocksCount: stocks.length, stocks });
    } catch (err) {
      res.status(200).json({ status: 'warning', message: 'No se pudo consultar ps_stock: ' + err.message, almacenes });
    }
    return;
  }

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
    // La key va en la URL (?ws_key=), no en el header Authorization: Basic
    // — Daiscom (el proveedor) confirmó que Apache/Cloudflare eliminan ese
    // header antes de llegar al webservice, así que siempre daba 401 aunque
    // la key fuera válida y estuviera activa.
    const url = `${baseUrl}/api/stock_availables?display=full&limit=0,${limit}&output_format=JSON&ws_key=${apiKey}`;

    const r = await fetch(url);
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
