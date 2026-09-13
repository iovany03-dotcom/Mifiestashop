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
// no fue accesible desde el entorno de desarrollo para confirmarla en vivo. El formato del
// cuerpo de la cotización se ajustó a partir de un error real de validación devuelto por la
// propia API en producción: Skydropx exige, además de country_code y postal_code, los campos
// area_level1 (estado), area_level2 (municipio) y area_level3 (colonia) en address_from/
// address_to — por eso esta función resuelve esos datos a partir del código postal usando la
// API pública y gratuita de SEPOMEX (api-sepomex.hckdrk.mx) antes de cotizar.

// Extrae estado/municipio/colonia de una fila de datos SEPOMEX, sin importar
// si usa nombres "amigables" (estado/municipio/asentamiento) o los nombres
// crudos originales del padrón (d_estado/d_mnpio/d_asenta).
function extractLevelsFromRow(resp) {
  if (!resp) return null;
  const estado = resp.estado || resp.d_estado;
  const municipio = resp.municipio || resp.d_mnpio;
  const asentamientoRaw = resp.asentamiento || resp.d_asenta;
  const asentamiento = Array.isArray(asentamientoRaw) ? asentamientoRaw[0] : asentamientoRaw;
  if (!estado || !municipio) return null;
  return { area_level1: estado, area_level2: municipio, area_level3: asentamiento || municipio };
}

// Resuelve estado/municipio/colonia a partir de un código postal mexicano.
// Se intentan dos fuentes públicas y gratuitas independientes (por si una de
// las dos está caída) porque no fue posible confirmar cuál es más confiable
// desde este entorno de desarrollo (ambos dominios están bloqueados en la
// sandbox, aunque sí son alcanzables desde Vercel en producción).
async function resolveAreaLevels(cp) {
  const sources = [
    {
      name: 'sepomex.nitrostudio.com.mx',
      url: `https://sepomex.nitrostudio.com.mx/api/latest/cp/${encodeURIComponent(cp)}.json`,
      extract: (data) => extractLevelsFromRow(Array.isArray(data) ? data[0] : (Array.isArray(data?.data) ? data.data[0] : data))
    },
    {
      name: 'api-sepomex.hckdrk.mx',
      url: `https://api-sepomex.hckdrk.mx/query/info_cp/${encodeURIComponent(cp)}?type=simplified`,
      extract: (data) => extractLevelsFromRow(data?.response || data?.cp?.response || data?.cp || data)
    }
  ];

  const reasons = [];
  for (const source of sources) {
    try {
      const r = await fetch(source.url);
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        reasons.push(`${source.name} HTTP ${r.status}${detail ? ': ' + detail.slice(0, 150) : ''}`);
        continue;
      }
      const data = await r.json();
      const levels = source.extract(data);
      if (levels) return { ok: true, levels };
      reasons.push(`${source.name} respuesta sin estado/municipio: ${JSON.stringify(data).slice(0, 150)}`);
    } catch (e) {
      reasons.push(`${source.name} error: ${e.message}`);
    }
  }
  return { ok: false, reason: reasons.join(' / ') };
}

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
          const detail = await tokenResp.text().catch(() => '');
          lastError = new Error(`Skydropx auth error ${tokenResp.status}${detail ? ': ' + detail.slice(0, 300) : ''}`);
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

  // Un intento con el cuerpo aplanado y otro anidado bajo "quotation" (por si
  // la API depende de uno de los dos formatos); ambos incluyen las claves
  // "packages" y "parcels" con el mismo contenido, ya que no se pudo
  // confirmar cuál de los dos nombres espera Skydropx y una clave extra sin
  // usar no debería causar problemas.
  async function createQuotation(authHeaders, addressFrom, addressTo) {
    const pkg = { weight: peso, length: largo, width: ancho, height: alto };
    const flat = { address_from: addressFrom, address_to: addressTo, packages: [pkg], parcels: [pkg] };
    const bodies = [flat, { quotation: flat }];

    let lastError = null;
    for (const body of bodies) {
      try {
        const createResp = await fetch(`${baseUrl}/api/v1/quotations`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(body)
        });
        if (!createResp.ok) {
          const detail = await createResp.text().catch(() => '');
          lastError = new Error(`Skydropx quotation error ${createResp.status}${detail ? ': ' + detail.slice(0, 300) : ''}`);
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
    const [resFrom, resTo] = await Promise.all([resolveAreaLevels(cpOrigen), resolveAreaLevels(cpDestino)]);
    if (!resFrom.ok || !resTo.ok) {
      const reasons = [!resFrom.ok ? `origen ${cpOrigen}: ${resFrom.reason}` : null, !resTo.ok ? `destino ${cpDestino}: ${resTo.reason}` : null].filter(Boolean).join(' | ');
      res.status(200).json({ fallback: true, rates: [], error: `No se pudo resolver estado/municipio/colonia para el código postal (${reasons})` });
      return;
    }

    const addressFrom = { country_code: 'MX', postal_code: cpOrigen, ...resFrom.levels };
    const addressTo = { country_code: 'MX', postal_code: cpDestino, ...resTo.levels };

    const accessToken = await getAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const quotationId = await createQuotation(authHeaders, addressFrom, addressTo);

    // La cotización de Skydropx es asíncrona: se consulta hasta que las
    // tarifas estén listas o se agoten los intentos (deja margen dentro del
    // maxDuration de la función).
    let rates = [];
    let lastPollDetail = '';
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const pollResp = await fetch(`${baseUrl}/api/v1/quotations/${quotationId}`, { headers: authHeaders });
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json();
      lastPollDetail = JSON.stringify(pollData).slice(0, 300);
      const rawRates = pollData.rates || pollData.data?.rates || [];
      if (Array.isArray(rawRates) && rawRates.length > 0) {
        rates = parseRates(rawRates);
        break;
      }
    }

    if (rates.length === 0) {
      res.status(200).json({ fallback: true, rates: [], error: `Sin tarifas disponibles para este destino${lastPollDetail ? ' (' + lastPollDetail + ')' : ''}` });
      return;
    }

    res.status(200).json({ rates, cheapest: rates[0] });
  } catch (err) {
    res.status(200).json({ fallback: true, rates: [], error: err.message });
  }
};
