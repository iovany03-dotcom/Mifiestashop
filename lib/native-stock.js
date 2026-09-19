'use strict';
const store = require('./migration-store');
const WAREHOUSES = { 53: 'CDMX Rumania', 55: 'Puebla', 56: 'Querétaro', 57: 'Guadalajara' };

async function branches(req, res) {
  const id = Number(req.query.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  try {
    const rows = await store.all('ps_stock', `select=*&id_product=eq.${id}&order=id_warehouse.asc`);
    const branches = rows.filter(row => WAREHOUSES[row.id_warehouse]).map(row => ({
      warehouseId: row.id_warehouse, name: WAREHOUSES[row.id_warehouse], qty: Number(row.quantity)
    }));
    res.status(200).json({ branches, total: branches.reduce((sum, row) => sum + row.qty, 0), source: 'supabase' });
  } catch (error) { res.status(503).json({ error: 'Inventario no disponible' }); }
}

async function inventory(req, res) {
  try {
    const [warehouses, rows] = await Promise.all([store.all('ps_almacenes'), store.all('ps_disponibilidad')]);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(5000, Math.max(1, Number.parseInt(req.query.limit,10) || 100));
    const stocks = rows.slice(offset, offset+limit).map(({ data: row }) => ({
      id: row.id, id_product: row.id_product, id_product_attribute: row.id_product_attribute,
      quantity: Number(row.quantity), id_shop: row.id_shop
    }));
    res.status(200).json({ status: 'ok', almacenes: warehouses, stocks, stocksCount: stocks.length, total: rows.length, source: 'supabase' });
  } catch (error) { res.status(503).json({ error: 'Inventario no disponible' }); }
}

module.exports = { branches, inventory };
