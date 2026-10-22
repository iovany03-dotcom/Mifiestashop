// Vercel serverless function: existencias por producto desde Supabase (ps_stock).
const { exigirSesion } = require('../lib/sesion-panel.js');
const { sbGetAll, fetchCatalogoActivo } = require('../lib/catalogo-supabase.js');

module.exports = async function handler(req, res) {
  // Datos privados del panel: solo con sesión (lib/sesion-panel.js) y nunca en la caché del CDN.
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await exigirSesion(req, res))) return;

  // Warehouses list
  const almacenes = [
    { id: 1, name: 'Puebla Principal', code: 'PUE' },
    { id: 2, name: 'CDMX Rumania', code: 'RUM' },
    { id: 3, name: 'Querétaro', code: 'QRO' },
    { id: 4, name: 'Atizapán', code: 'ATZ' },
    { id: 5, name: 'CDMX Popocatépetl', code: 'POP' }
  ];

  // Existencias de ps_stock, sumadas por producto.
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 5000);
    // Solo productos activos del catálogo (ps_stock trae ~80,000 filas,
    // incluidas las de productos inactivos): los primeros `limit`.
    const ids = (await fetchCatalogoActivo('id')).slice(0, limit).map(r => r.id);
    const byProduct = new Map(ids.map(id => [id, 0]));
    for (let i = 0; i < ids.length; i += 200) {
      (await sbGetAll(`ps_stock?select=id_product,quantity&id_product=in.(${ids.slice(i, i + 200).join(',')})`, { privado: true }))
        .forEach(s => byProduct.set(s.id_product, (byProduct.get(s.id_product) || 0) + (Number(s.quantity) || 0)));
    }
    const stocks = [...byProduct.entries()].map(([idProduct, qty]) => ({
      id: idProduct, id_product: String(idProduct), id_product_attribute: '0', quantity: Math.round(qty), id_shop: '1'
    }));
    res.status(200).json({ status: 'ok', source: 'supabase', almacenes, stocksCount: stocks.length, stocks });
  } catch (err) {
    res.status(200).json({ status: 'warning', message: 'No se pudo consultar ps_stock: ' + err.message, almacenes });
  }
};
