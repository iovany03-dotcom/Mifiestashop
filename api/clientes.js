// Vercel serverless function: fetches customers from PrestaShop API
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({
      fallback: true,
      customers: [
        { id: 1, name: 'Cliente Mostrador (General)', email: 'mostrador@mifiestashop.com', rfc: 'XAXX010101000', date: '2026-01-01' },
        { id: 2, name: 'Juan Pérez', email: 'juan.perez@gmail.com', rfc: 'PERJ890101XXX', date: '2026-03-12' },
        { id: 3, name: 'María López', email: 'maria.lopez@yahoo.com', rfc: 'LOPM920405YYY', date: '2026-05-20' },
        { id: 4, name: 'Distribuidora de Fiestas S.A.', email: 'ventas@distribuidorafiestas.com', rfc: 'DFI891012AB3', date: '2026-06-15' }
      ]
    });
    return;
  }

  const url = `${baseUrl}/api/customers?display=[id,firstname,lastname,email,date_add,active]&limit=0,200&output_format=JSON`;
  // El RFC/identificador fiscal en PrestaShop se guarda en la dirección del
  // cliente (campo "dni"), no en el propio recurso "customers".
  const addressesUrl = `${baseUrl}/api/addresses?display=[id_customer,dni]&limit=0,500&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`PrestaShop API error ${r.status}`);

    const data = await r.json();
    const rawCust = Array.isArray(data.customers) ? data.customers : [];

    const rfcByCustomer = {};
    try {
      const ra = await fetch(addressesUrl, { headers });
      if (ra.ok) {
        const adata = await ra.json();
        const rawAddr = Array.isArray(adata.addresses) ? adata.addresses : [];
        rawAddr.forEach(a => {
          if (a.dni && !rfcByCustomer[a.id_customer]) rfcByCustomer[a.id_customer] = a.dni;
        });
      }
    } catch (e) {
      // Si falla la consulta de direcciones, seguimos sin RFC en vez de inventar uno.
    }

    const customers = rawCust.map(c => ({
      id: c.id,
      name: `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente PrestaShop',
      email: c.email || '—',
      rfc: rfcByCustomer[c.id] || '—',
      date: c.date_add ? c.date_add.slice(0, 10) : '—',
      active: c.active === '1' || c.active === 1
    }));

    res.status(200).json({ customers });
  } catch (err) {
    res.status(200).json({
      fallback: true,
      error: err.message,
      customers: [
        { id: 1, name: 'Cliente Mostrador (General)', email: 'mostrador@mifiestashop.com', rfc: 'XAXX010101000', date: '2026-01-01' },
        { id: 2, name: 'Juan Pérez', email: 'juan.perez@gmail.com', rfc: 'PERJ890101XXX', date: '2026-03-12' },
        { id: 3, name: 'María López', email: 'maria.lopez@yahoo.com', rfc: 'LOPM920405YYY', date: '2026-05-20' }
      ]
    });
  }
};
