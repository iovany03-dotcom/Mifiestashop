// Vercel serverless function: lee el stock de TODOS los productos por
// almacén desde nuestra propia copia en Supabase (ps_stock), sincronizada
// cada hora por api/cron-sync-prestashop.js — usado por el Backoffice
// (Inventario, POS, Traspasos). Ya no consulta PrestaShop en cada carga.
const WAREHOUSE_TO_KEY = {
  '55': 'puebla',
  '53': 'rumania',
  '56': 'queretaro'
};

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // ps_stock tiene decenas de miles de filas (producto x almacén) —
    // el límite por defecto de PostgREST (1000) se evita paginando con
    // el header Range, igual que en api/clientes.js.
    const PAGE_SIZE = 1000;
    let rows = [];
    let from = 0;
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/ps_stock?select=id_product,id_warehouse,quantity`;
      const r = await fetch(url, {
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${from}-${from + PAGE_SIZE - 1}`
        }
      });
      if (!r.ok) throw new Error(`Supabase error ${r.status}`);
      const batch = await r.json();
      rows = rows.concat(batch);
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    const stock = {};
    rows.forEach(s => {
      const whKey = WAREHOUSE_TO_KEY[String(s.id_warehouse)];
      if (!whKey) return; // bodega no usada en el Backoffice (ej. Atizapán, CDMX Popocatépetl)
      const pid = String(s.id_product);
      if (!stock[pid]) stock[pid] = { puebla: 0, rumania: 0, queretaro: 0 };
      stock[pid][whKey] += s.quantity || 0;
    });

    res.status(200).json({ stock, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ error: err.message, stock: {}, fallback: true });
  }
};
