// Vercel serverless function: cotiza envíos reales con la API de Skydropx
// (OAuth2 client_credentials + cotización asíncrona por polling).
//
// GET/POST /api/skydropx-cotizar?cp_origen=72000&cp_destino=76000&peso=1&largo=30&ancho=25&alto=15
// -> { rates: [{ carrier, service, price, days }], cheapest }
// -> { fallback: true, rates: [], error } si no hay credenciales o falla la cotización
//
// Requires env vars (configúralas en Vercel → Settings → Environment Variables,
// nunca en el código fuente):
//   SKYDROPX_API_KEY       Clave de cliente (API Key) de Skydropx
//   SKYDROPX_API_SECRET    Clave secreta del cliente (API Secret key) de Skydropx
//   SKYDROPX_BASE_URL      Opcional, por defecto https://api.skydropx.com

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const clientId = process.env.SKYDROPX_API_KEY;
  const clientSecret = process.env.SKYDROPX_API_SECRET;
  const baseUrl = process.env.SKYDROPX_BASE_URL || 'https://api.skydropx.com';

  if (!clientId || !clientSecret) {
    res.status(200).json({ fallback: true, rates: [], error: 'Skydropx no configurado (faltan SKYDROPX_API_KEY / SKYDROPX_API_SECRET en Vercel)' });
    return;
  }

  const params = req.method === 'GET' ? req.query : (req.body || {});
  const cpOrigen = String(params.cp_origen || '72000');
  const cpDestino = String(params.cp_destino || '');
  const peso = parseFloat(params.peso || '1');
  const largo = parseFloat(params.largo || '30');
  const ancho = parseFloat(params.ancho || '25');
  const alto = parseFloat(params.alto || '15');

  if (!cpDestino) {
    res.status(400).json({ error: 'Falta cp_destino' });
    return;
  }

  try {
    // 1) Autenticación OAuth2 client_credentials
    const tokenResp = await fetch(`${baseUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    if (!tokenResp.ok) throw new Error(`Skydropx auth error ${tokenResp.status}`);
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('Skydropx no devolvió access_token');

    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

    // 2) Crear cotización
    const quotationBody = {
      quotation: {
        address_from: { country_code: 'mx', zip_code: cpOrigen },
        address_to: { country_code: 'mx', zip_code: cpDestino },
        parcels: [{ weight: peso, length: largo, width: ancho, height: alto }]
      }
    };
    const createResp = await fetch(`${baseUrl}/api/v1/quotations`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(quotationBody)
    });
    if (!createResp.ok) throw new Error(`Skydropx quotation error ${createResp.status}`);
    const createData = await createResp.json();
    const quotationId = createData.id || createData.data?.id;
    if (!quotationId) throw new Error('Skydropx no devolvió id de cotización');

    // 3) La cotización de Skydropx es asíncrona: se consulta hasta que las
    // tarifas estén listas o se agoten los intentos (deja margen dentro del
    // maxDuration de la función).
    let rates = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const pollResp = await fetch(`${baseUrl}/api/v1/quotations/${quotationId}`, { headers: authHeaders });
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json();
      const rawRates = pollData.rates || pollData.data?.rates || [];
      if (Array.isArray(rawRates) && rawRates.length > 0) {
        rates = rawRates
          .filter((r) => r.success !== false)
          .map((r) => ({
            carrier: r.provider_name || r.carrier || 'Paquetería',
            service: r.provider_service_name || r.service_level_name || '',
            price: parseFloat(r.total_pricing || r.amount || 0),
            days: r.days || r.delivery_estimate || null
          }))
          .filter((r) => r.price > 0)
          .sort((a, b) => a.price - b.price);
        break;
      }
    }

    if (rates.length === 0) {
      res.status(200).json({ fallback: true, rates: [], error: 'Sin tarifas disponibles para este destino' });
      return;
    }

    res.status(200).json({ rates, cheapest: rates[0] });
  } catch (err) {
    res.status(200).json({ fallback: true, rates: [], error: err.message });
  }
};
