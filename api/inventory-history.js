'use strict';
const store = require('../lib/migration-store');

// Imported history is read-only. Its quantities are already in the stock snapshot.
module.exports = async function inventoryHistory(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!await store.requireSession(req)) return res.status(401).json({ error: 'Sesión requerida' });
    const id = req.query?.id;
    if (id !== undefined) {
      if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) {
        return res.status(400).json({ error: 'Documento inválido' });
      }
      const rows = await store.request(`ps_inventory_documents?select=data&id=eq.${Number(id)}&limit=1`);
      return rows.length ? res.status(200).json({ document: rows[0].data }) : res.status(404).json({ error: 'Documento no encontrado' });
    }
    const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
    const rows = await store.request(`ps_inventory_documents?select=id,data&order=id.desc&offset=${offset}&limit=51`);
    const documents = rows.slice(0, 50).map(({ id, data }) => ({
      id, document: data.document, date: data.date, warehouse: data.warehouse,
      status: data.status, responsible: data.responsible, lines: data.lines.length
    }));
    return res.status(200).json({ documents, hasMore: rows.length > 50, nextOffset: offset + documents.length });
  } catch (_) {
    return res.status(503).json({ error: 'No se pudo consultar el historial de inventario' });
  }
};
