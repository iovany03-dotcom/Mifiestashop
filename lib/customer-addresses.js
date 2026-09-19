'use strict';

const clean = value => value == null ? '' : String(value).trim();
const flag = value => value === true || value === 1 || value === '1';

function normalizeAddress(row) {
  const id = Number(row.id), customerId = Number(row.id_customer);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(customerId) || customerId < 0) {
    throw new Error('Identificador inválido en addresses');
  }
  return {
    id, id_customer: customerId, alias: clean(row.alias), firstname: clean(row.firstname), lastname: clean(row.lastname),
    company: clean(row.company), address1: clean(row.address1), address2: clean(row.address2), city: clean(row.city),
    postcode: clean(row.postcode), id_state: Number(row.id_state) || null, id_country: Number(row.id_country) || null,
    phone: clean(row.phone), phone_mobile: clean(row.phone_mobile), dni: clean(row.dni), vat_number: clean(row.vat_number),
    deleted: flag(row.deleted), active: row.active === undefined || flag(row.active),
    date_upd: row.date_upd && !String(row.date_upd).startsWith('0000-') ? row.date_upd : null,
    synced_at: new Date().toISOString()
  };
}

function addressesByCustomer(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row.deleted || !row.active || !row.id_customer) continue;
    const id = String(row.id_customer);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  for (const addresses of map.values()) addresses.sort((a, b) =>
    String(b.date_upd || '').localeCompare(String(a.date_upd || '')) || b.id - a.id);
  return map;
}

function enrichCustomer(customer, addresses = []) {
  const primary = addresses.find(a => a.address1) || addresses[0];
  const fiscal = addresses.find(a => a.dni || a.vat_number);
  const phone = addresses.find(a => a.phone_mobile || a.phone);
  return {
    ...customer,
    rfc: fiscal ? fiscal.dni || fiscal.vat_number : customer.rfc || null,
    phone: phone ? phone.phone_mobile || phone.phone : customer.phone || null,
    address: primary ? [primary.address1, primary.address2].filter(Boolean).join(', ') : customer.address || null,
    city: primary?.city || customer.city || null,
    postcode: primary?.postcode || customer.postcode || null,
    addresses
  };
}

module.exports = { normalizeAddress, addressesByCustomer, enrichCustomer };
