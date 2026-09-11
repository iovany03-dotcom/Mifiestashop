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

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) throw new Error(`PrestaShop API error ${r.status}`);

    const data = await r.json();
    const rawCust = Array.isArray(data.customers) ? data.customers : [];

    const customers = rawCust.map(c => ({
      id: c.id,
      name: `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente PrestaShop',
      email: c.email || '—',
      rfc: `RFC-PS-${c.id}`,
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
