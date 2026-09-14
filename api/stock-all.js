// Vercel serverless function: real stock for ALL products across the
// warehouses used by the admin Backoffice (Inventario, POS, Traspasos).
//
// A single call to /api/stocks?filter[id_product]=X (see stock-sucursal.js)
// works fine for one product at a time on the public product page, but the
// admin inventory table needs every product at once — so this paginates
// through the whole "stocks" resource instead of calling it once per
// product, the same time-budgeted pattern used by api/clientes.js.
const WAREHOUSE_TO_KEY = {
  '55': 'puebla',
  '53': 'rumania',
  '56': 'queretaro'
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, stock: {} });
    return;
  }

  const PAGE_SIZE = 1000;
  const TIME_BUDGET_MS = 8000;
  const startedAt = Date.now();
  const fields = '[id_product,id_warehouse,usable_quantity]';

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    // stock[id_product] = { puebla, rumania, queretaro }
    const stock = {};
    let page = 0;
    let truncated = false;

    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { truncated = true; break; }
      const url = `${baseUrl}/api/stocks?display=${encodeURIComponent(fields)}&limit=${page * PAGE_SIZE},${PAGE_SIZE}&output_format=JSON`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`PrestaShop API error ${r.status}: ${detail.slice(0, 300)}`);
      }
      const data = await r.json();
      const batch = Array.isArray(data.stocks) ? data.stocks : [];

      batch.forEach(s => {
        const whKey = WAREHOUSE_TO_KEY[String(s.id_warehouse)];
        if (!whKey) return; // bodega no usada en el Backoffice (ej. Atizapán, CDMX Popocatépetl)
        const pid = String(s.id_product);
        if (!stock[pid]) stock[pid] = { puebla: 0, rumania: 0, queretaro: 0 };
        stock[pid][whKey] += Math.round(parseFloat(s.usable_quantity || 0));
      });

      if (batch.length < PAGE_SIZE) break;
      page++;
    }

    res.status(200).json({ stock, truncated });
  } catch (err) {
    res.status(200).json({ error: err.message, stock: {}, fallback: true });
  }
};
