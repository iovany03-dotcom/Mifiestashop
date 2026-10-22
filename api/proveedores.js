// Vercel serverless function: lista de proveedores (ps_proveedores en Supabase).
const { exigirSesion } = require('../lib/sesion-panel.js');
const { sbGetAll } = require('../lib/catalogo-supabase.js');

module.exports = async function handler(req, res) {
  // Datos privados del panel: solo con sesión (lib/sesion-panel.js) y nunca en la caché del CDN.
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await exigirSesion(req, res))) return;

  // ps_proveedores solo tiene nombre y estado (lo que traía PrestaShop).
  try {
    const rows = await sbGetAll('ps_proveedores?select=id,name,active&order=id.asc', { privado: true });
    const suppliers = rows.map(s => ({
      id: s.id,
      name: s.name || `Proveedor #${s.id}`,
      contact: 'Contacto Registrado',
      phone: '+52 55 0000 0000',
      email: `contacto.prov${s.id}@mifiestashop.com`,
      status: s.active ? 'Activo' : 'Inactivo'
    }));
    res.status(200).json({ suppliers, source: 'supabase' });
  } catch (err) {
    res.status(200).json({ suppliers: [], error: err.message });
  }
};
