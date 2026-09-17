'use strict';
const store = require('./migration-store');
const { addressesByCustomer, enrichCustomer } = require('./customer-addresses');

module.exports = async function customers(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!await store.requireSession(req)) return res.status(401).json({ error: 'Sesión requerida' });
    const [rows, addresses] = await Promise.all([store.all('ps_clientes'), store.all('ps_direcciones')]);
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
    return res.status(200).json({ customers, count: customers.length, source: 'supabase' });
  } catch (error) { return res.status(503).json({ error: 'No se pudieron cargar los clientes' }); }
};
