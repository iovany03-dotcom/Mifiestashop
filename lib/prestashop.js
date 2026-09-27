// Interruptor único de conexión en vivo con PrestaShop.
//
// DESCONECTADO (default): el sitio, el checkout, el POS, las fotos, los
// reportes y la API pública se sirven 100% desde Supabase — ninguna
// petición de un visitante o del admin consulta PrestaShop en vivo, así
// que si PrestaShop se cae el sitio sigue funcionando. La sincronización
// en segundo plano (api/cron-sync-prestashop.js + lib/sync-prestashop.js)
// NO depende de este interruptor: sigue trayendo productos, precios,
// fotos, stock, pedidos y clientes de PrestaShop hacia Supabase, porque
// las cajas de las tiendas siguen vendiendo en PrestaShop.
//
// RESPALDO PARA RECONECTAR: en Vercel → Settings → Environment Variables,
// poner PRESTASHOP_CONECTADO=1 (Production) y redesplegar. Con eso cada
// endpoint vuelve a su camino original de consulta en vivo, que se dejó
// intacto detrás de este interruptor. Para volver a desconectar se borra
// la variable (o se pone en 0) y se redespliega.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

function prestashopConectado() {
  const v = String(process.env.PRESTASHOP_CONECTADO || '').trim().toLowerCase();
  return ['1', 'true', 'si', 'sí', 'on'].includes(v);
}

// Lee todas las filas de una consulta de PostgREST (corta en 1000 por
// petición, así que se pagina). `query` es lo que va después de /rest/v1/.
async function sbGetAll(query) {
  const PAGE = 1000;
  const out = [];
  const sep = query.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += PAGE) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}${sep}limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Supabase ${query.split('?')[0]} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Catálogo activo (catalogo_productos, sincronizado desde PrestaShop cada
// 10 min) — mismas filas que antes devolvía filter[active]=1 en vivo.
const CATALOGO_COLUMNS = 'id,sku,barcode,name,description,description_short,price,category_id,category_label,price_mayoreo,price_mayoreo_desde_unidades,costo_compra,low_stock_threshold,weight,width,height,depth,meta_title,meta_description,meta_keywords,link_rewrite,images,source';

async function fetchCatalogoActivo(select = CATALOGO_COLUMNS, extraFilter = '') {
  return sbGetAll(`catalogo_productos?select=${select}&active=eq.true${extraFilter}&order=id.asc`);
}

// Filas de catalogo_productos por id (activas o no), en lotes.
async function fetchCatalogoRows(ids, select = CATALOGO_COLUMNS + ',active') {
  const clean = [...new Set((ids || []).map(String).filter(s => /^\d+$/.test(s)))];
  const out = [];
  for (let i = 0; i < clean.length; i += 200) {
    out.push(...await sbGetAll(`catalogo_productos?select=${select}&id=in.(${clean.slice(i, i + 200).join(',')})`));
  }
  return out;
}

// Precio y datos reales (sincronizados) de productos activos, para validar
// el carrito del checkout sin consultar PrestaShop: { "83341": row }.
async function fetchPreciosActivos(ids) {
  const rows = await fetchCatalogoRows(ids, 'id,name,sku,price,active');
  const map = {};
  rows.forEach(r => { if (r.active) map[String(r.id)] = r; });
  return map;
}

module.exports = { prestashopConectado, sbGetAll, fetchCatalogoActivo, fetchCatalogoRows, fetchPreciosActivos, SUPABASE_URL, SUPABASE_ANON_KEY };
