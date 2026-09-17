'use strict';
const store = require('./migration-store');
const { addressesByCustomer, enrichCustomer } = require('./customer-addresses');

module.exports = async function customers(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!await store.requireSession(req)) return res.status(401).json({ error: 'Sesión requerida' });
    const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
    const limit = 250;
    const page = await store.request(`ps_clientes?select=*&order=id.asc&offset=${offset}&limit=${limit+1}`);
    if (!Array.isArray(page)) throw new Error('Directorio inválido');
    const rows = page.slice(0, limit);
    const ids = rows.map(row => Number(row.id));
    const addresses = ids.length ? await store.all('ps_direcciones', `select=*&id_customer=in.(${ids.join(',')})&order=id.asc`) : [];
    const byCustomer = addressesByCustomer(addresses);
    const customers = rows.map(row => {
      const customer = enrichCustomer(row, byCustomer.get(String(row.id)) || []);
      return {
        id: customer.id, name: customer.name, email: customer.email,
        rfc: customer.rfc || '—', phone: customer.phone || '—', address: customer.address || '',
        city: customer.city || '', postcode: customer.postcode || '', addresses: customer.addresses,
        date: String(customer.date_add || '').slice(0,10), active: customer.active,
        birthday: customer.birthday, company: customer.company, newsletter: customer.newsletter, isGuest: customer.is_guest
      };
    });
    return res.status(200).json({ customers, count: customers.length, hasMore: page.length > limit, nextOffset: offset + rows.length, source: 'supabase' });
  } catch (error) { return res.status(503).json({ error: 'No se pudieron cargar los clientes' }); }
};
