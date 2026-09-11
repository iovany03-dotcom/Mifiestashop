// Vercel serverless function: fetches suppliers/proveedores from PrestaShop API
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({
      fallback: true,
      suppliers: [
        { id: 1, name: 'Distribuidora Nacional de Globos S.A.', contact: 'Contacto Ventas', phone: '+52 55 5555 1234', email: 'ventas@globosnacional.com', status: 'Activo' },
        { id: 2, name: 'Empaques y Desechables de México', contact: 'Atención a Clientes', phone: '+52 55 4444 8888', email: 'contacto@empaquesmex.com', status: 'Activo' },
        { id: 3, name: 'Importadora Festiva Internacional', contact: 'Gerencia de Importaciones', phone: '+52 33 3333 9999', email: 'pedidos@festivaint.com', status: 'Activo' }
      ]
    });
    return;
  }

  const url = `${baseUrl}/api/suppliers?display=[id,name,active,date_add]&limit=0,100&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) throw new Error(`PrestaShop API error ${r.status}`);

    const data = await r.json();
    const rawSuppliers = Array.isArray(data.suppliers) ? data.suppliers : [];

    const suppliers = rawSuppliers.map(s => ({
      id: s.id,
      name: s.name || `Proveedor #${s.id}`,
      contact: 'Contacto Registrado',
      phone: '+52 55 0000 0000',
      email: `contacto.prov${s.id}@mifiestashop.com`,
      status: s.active === '1' || s.active === 1 ? 'Activo' : 'Inactivo'
    }));

    res.status(200).json({ suppliers });
  } catch (err) {
    res.status(200).json({
      fallback: true,
      error: err.message,
      suppliers: [
        { id: 1, name: 'Distribuidora Nacional de Globos S.A.', contact: 'Contacto Ventas', phone: '+52 55 5555 1234', email: 'ventas@globosnacional.com', status: 'Activo' },
        { id: 2, name: 'Empaques y Desechables de México', contact: 'Atención a Clientes', phone: '+52 55 4444 8888', email: 'contacto@empaquesmex.com', status: 'Activo' }
      ]
    });
  }
};
