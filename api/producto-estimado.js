// Vercel serverless function: estimado de ventas mensuales de un producto para el editor del admin
// (ver lib/estimado-ventas.js): promedio real con las ventas que registra el sistema (PrestaShop + POS
// propio) y, si el producto casi no se ha vendido o es nuevo, un estimado por parecido con productos
// similares que sí se venden. También cuántos meses alcanza el stock actual a ese ritmo.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, id?, name?, categoryLabel?, price? }
//   (con "id" toma nombre/categoría/precio del catálogo; sin él sirve para un producto aún sin guardar)
// -> { real, estimado, fuente: 'real' | 'similares' | 'sin_datos', stock, mesesDeStock }
const { agregarVentas, estimarReal, estimarPorSimilares } = require('../lib/estimado-ventas.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const STOCK_VIRTUAL = 30000; // PrestaShop usa 30,000 como "stock infinito" en productos bajo pedido
const WAREHOUSES = [53, 55, 56];

async function checkSession(b) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_admin_password: b.p_admin_password ?? null, p_staff_email: b.p_staff_email ?? null, p_staff_pin: b.p_staff_pin ?? null })
  });
  return r.ok && !!(await r.json());
}

async function getAll(path, key) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}`);
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

// Ventas y catálogo cambian poco: se reutilizan 5 minutos entre aperturas del editor.
let cache = null;
async function cargarBase(key) {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.data;
  const [ps, pos, catalogo] = await Promise.all([
    getAll('ps_ventas_producto_mes?select=product_id,month,units&order=product_id.asc,month.asc', key),
    getAll('pos_ventas_producto_mes?select=product_id,month,units&order=product_id.asc,month.asc', key).catch(() => []),
    getAll('catalogo_productos?select=id,name,category_label,price&order=id.asc', key)
  ]);
  const data = { ventas: agregarVentas(ps.concat(pos)), catalogo };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }
  if (!(await checkSession(body).catch(() => false))) { res.status(401).json({ error: 'unauthorized' }); return; }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }

  try {
    const { ventas, catalogo } = await cargarBase(key);
    const hoy = new Date();
    const id = body.id != null && body.id !== '' ? String(body.id) : null;
    const actual = id ? catalogo.find(c => String(c.id) === id) : null;
    const objetivo = {
      id,
      name: String((actual && actual.name) || body.name || '').slice(0, 200),
      categoryLabel: (actual && actual.category_label) || body.categoryLabel || '',
      price: Number((actual && actual.price) || body.price) || 0
    };

    const real = id ? estimarReal(ventas.porProducto.get(id), ventas.primerMes, hoy) : { promedio: 0, meses: 0, mesesConVenta: 0, unidades: 0, mesActual: null };
    let estimado = null, fuente = 'sin_datos';
    if (real.mesesConVenta >= 2) {
      fuente = 'real';
    } else if (objetivo.name) {
      // Casi sin historial propio: se estima por parecido con productos que sí se venden.
      const candidatos = [];
      catalogo.forEach(c => {
        const r = estimarReal(ventas.porProducto.get(String(c.id)), ventas.primerMes, hoy);
        if (r.mesesConVenta >= 2) candidatos.push({ id: c.id, name: c.name, categoryLabel: c.category_label, price: c.price, promedio: r.promedio });
      });
      estimado = estimarPorSimilares(objetivo, candidatos);
      if (estimado) fuente = 'similares';
      else if (real.unidades > 0) fuente = 'real';
    }

    // Stock actual (PrestaShop + movimientos del kardex) y cuántos meses alcanza al ritmo estimado.
    let stock = null, mesesDeStock = null;
    if (id) {
      const [st, mv] = await Promise.all([
        getAll(`ps_stock?select=quantity,id_warehouse&id_product=eq.${encodeURIComponent(id)}`, key).catch(() => []),
        getAll(`pos_stock_moves?select=qty&id_product=eq.${encodeURIComponent(id)}`, key).catch(() => [])
      ]);
      const base = st.filter(s => WAREHOUSES.includes(Number(s.id_warehouse))).reduce((s, x) => s + (Number(x.quantity) || 0), 0);
      const delta = mv.reduce((s, x) => s + (Number(x.qty) || 0), 0);
      if (base < STOCK_VIRTUAL) {
        stock = Math.round(base + delta);
        const ritmo = fuente === 'real' ? real.promedio : (estimado ? estimado.promedio : 0);
        if (stock > 0 && ritmo > 0) mesesDeStock = Math.round((stock / ritmo) * 10) / 10;
      }
    }

    const redondea = v => Math.round(v * 10) / 10;
    res.status(200).json({
      fuente,
      real: { ...real, promedio: redondea(real.promedio) },
      estimado: estimado ? { ...estimado, promedio: redondea(estimado.promedio), bajo: redondea(estimado.bajo), alto: redondea(estimado.alto) } : null,
      stock, mesesDeStock,
      datosDesde: ventas.primerMes
    });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo calcular el estimado', detail: String(e.message || e).slice(0, 200) });
  }
};
