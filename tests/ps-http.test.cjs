const test = require('node:test'), assert = require('node:assert/strict');
const { originFor, prestashopFetch } = require('../lib/ps-http.js');

test('ps-http: sin PS_ORIGIN_IP es un fetch normal', async () => {
  delete process.env.PS_ORIGIN_IP;
  assert.equal(originFor('https://www.mifiestashop.com/api/orders'), null);
  let called = null;
  global.fetch = async (url) => { called = url; return { ok: true }; };
  await prestashopFetch('https://www.mifiestashop.com/api/orders?ws_key=x');
  assert.equal(called, 'https://www.mifiestashop.com/api/orders?ws_key=x');
});

test('ps-http: con PS_ORIGIN_IP solo desvía las URLs de la tienda', () => {
  process.env.PS_ORIGIN_IP = '203.0.113.7';
  const o = originFor('https://www.mifiestashop.com/api/orders?a=1');
  assert.equal(o.ip, '203.0.113.7'); assert.equal(o.url.hostname, 'www.mifiestashop.com'); assert.equal(o.url.search, '?a=1');
  assert.ok(originFor('https://mifiestashop.com/api/stock_availables'));
  assert.equal(originFor('https://iuoirslxjcyarvmrqyjd.supabase.co/rest/v1/x'), null);
  assert.equal(originFor('https://cdn1.mifiestashop.com/img/a.jpg'), null);
  assert.equal(originFor('http://www.mifiestashop.com/api/orders'), null);
  delete process.env.PS_ORIGIN_IP;
});
