// Vercel serverless function: cotiza envíos reales con la API de Skydropx Pro
// (OAuth2 client_credentials + cotización asíncrona por polling).
//
// GET/POST /api/skydropx-cotizar?cp_origen=72000&cp_destino=76000&peso=1&largo=30&ancho=25&alto=15
// -> { rates: [{ carrier, service, price, days }], cheapest }
// -> { fallback: true, rates: [], error } si no hay credenciales o falla la cotización
//
// Requires env vars (configúralas en Vercel → Settings → Environment Variables,
// nunca en el código fuente):
//   SKYDROPX_API_KEY       Clave de cliente (Client ID) de Skydropx Pro
//   SKYDROPX_API_SECRET    Clave secreta del cliente (Client Secret) de Skydropx Pro
//   SKYDROPX_BASE_URL      Opcional, por defecto https://pro.skydropx.com (panel Skydropx Pro)
//
// Nota de confianza: la documentación pública de Skydropx Pro (pro.skydropx.com/es-MX/api-docs)
// no es accesible desde este entorno de desarrollo para verificarla en vivo, así que esta
// integración intenta automáticamente las variantes más comunes documentadas externamente
// (content-type del token, formato del cuerpo de la cotización) antes de rendirse, para
// no depender de adivinar un único formato exacto.

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const clientId = process.env.SKYDROPX_API_KEY;
  const clientSecret = process.env.SKYDROPX_API_SECRET;
  const baseUrl = process.env.SKYDROPX_BASE_URL || 'https://pro.skydropx.com';

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

  // El formato exacto del cuerpo de autenticación (JSON vs. form-urlencoded)
  // varía según la fuente consultada; se intenta primero el formato estándar
  // de OAuth2 (form-urlencoded, RFC 6749) y si falla se reintenta con JSON.
  async function getAccessToken() {
    const attempts = [
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString()
      },
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
      }
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const tokenResp = await fetch(`${baseUrl}/api/v1/oauth/token`, {
          method: 'POST',
          headers: attempt.headers,
          body: attempt.body
        });
        if (!tokenResp.ok) {
          lastError = new Error(`Skydropx auth error ${tokenResp.status}`);
          continue;
        }
        const tokenData = await tokenResp.json();
        if (tokenData.access_token) return tokenData.access_token;
        lastError = new Error('Skydropx no devolvió access_token');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('No se pudo autenticar con Skydropx');
  }

  // Igual que con la autenticación, se intenta primero el cuerpo anidado bajo
  // "quotation" (formato más común en la documentación) y, si la API lo
  // rechaza, se reintenta con el cuerpo plano.
  async function createQuotation(authHeaders) {
    const parcel = { weight: peso, length: largo, width: ancho, height: alto };
    const addressFrom = { country_code: 'mx', zip_code: cpOrigen };
    const addressTo = { country_code: 'mx', zip_code: cpDestino };

    const bodies = [
      { quotation: { address_from: addressFrom, address_to: addressTo, parcels: [parcel] } },
      { address_from: addressFrom, address_to: addressTo, parcels: [parcel] }
    ];

    let lastError = null;
    for (const body of bodies) {
      try {
        const createResp = await fetch(`${baseUrl}/api/v1/quotations`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(body)
        });
        if (!createResp.ok) {
          lastError = new Error(`Skydropx quotation error ${createResp.status}`);
          continue;
        }
        const createData = await createResp.json();
        const quotationId = createData.id || createData.data?.id;
        if (quotationId) return quotationId;
        lastError = new Error('Skydropx no devolvió id de cotización');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('No se pudo crear la cotización en Skydropx');
  }

  function parseRates(rawRates) {
    return rawRates
      .filter((r) => r.success !== false)
      .map((r) => ({
        carrier: r.provider_name || r.carrier_name || r.carrier || 'Paquetería',
        service: r.provider_service_name || r.service_level_name || r.service || '',
        price: parseFloat(r.total_pricing || r.total || r.amount || 0),
        days: r.days || r.delivery_estimate || null
      }))
      .filter((r) => r.price > 0)
      .sort((a, b) => a.price - b.price);
  }

  try {
    const accessToken = await getAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const quotationId = await createQuotation(authHeaders);

    // La cotización de Skydropx es asíncrona: se consulta hasta que las
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
        rates = parseRates(rawRates);
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
