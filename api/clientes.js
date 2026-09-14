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

  // El webservice de esta tienda no deja ordenar/filtrar el recurso
  // "customers" por date_add (PrestaShop responde 400: "Unable to filter
  // by this field"), así que se ordena por id descendente — en PrestaShop
  // los ids son consecutivos según se crea la cuenta, así que sigue
  // mostrando primero a los clientes más recientes.
  //
  // Esta tienda tiene varios miles de clientes reales (más de los 6000 que
  // un primer intento con un límite fijo de páginas llegó a cortar), así
  // que en vez de un número fijo de páginas se pagina hasta agotar los
  // resultados, con un presupuesto de tiempo para no exceder el límite de
  // ejecución de la función serverless.
  const PAGE_SIZE = 500;
  const TIME_BUDGET_MS = 8000;
  const startedAt = Date.now();
  const fields = '[id,firstname,lastname,email,date_add,active]';

  // El RFC/identificador fiscal en PrestaShop se guarda en la dirección del
  // cliente (campo "dni"), no en el propio recurso "customers".
  const addressesUrl = `${baseUrl}/api/addresses?display=[id_customer,dni]&limit=0,1000&output_format=JSON`;

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    // Trae TODOS los clientes paginando, no solo los primeros 200 (ni un
    // número fijo de páginas): sigue mientras la página venga llena y
    // quede presupuesto de tiempo; si se agota el tiempo antes de terminar,
    // se devuelve lo recabado hasta ahí en vez de fallar por completo.
    let rawCust = [];
    let page = 0;
    let truncatedByTime = false;
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { truncatedByTime = true; break; }
      const url = `${baseUrl}/api/customers?display=${encodeURIComponent(fields)}&sort=[id_DESC]&limit=${page * PAGE_SIZE},${PAGE_SIZE}&output_format=JSON`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`PrestaShop API error ${r.status}: ${detail.slice(0, 300)}`);
      }
      const data = await r.json();
      const batch = Array.isArray(data.customers) ? data.customers : [];
      rawCust = rawCust.concat(batch);
      if (batch.length < PAGE_SIZE) break; // última página
      page++;
    }

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

    res.status(200).json({ customers, count: customers.length, truncated: truncatedByTime });
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
