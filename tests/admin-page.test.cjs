const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const handler = require('../api/admin-page.js');

test('admin-page: /admin sale con el manifest, ícono y nombre del back office', async () => {
  const res = { code: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
  await handler({ headers: { host: 'mifiestashop.vercel.app' } }, res);
  assert.equal(res.code, 200);
  assert.match(res.body, /<link rel="manifest" href="\/manifest-admin.json">/);
  assert.match(res.body, /admin-apple-touch-icon\.png/);
  assert.match(res.body, /content="MF Admin"/);
  assert.doesNotMatch(res.body, /href="\/manifest.json"/);
});

test('admin-page: manifest-admin.json abre en /admin y vercel.json enruta /admin a la función', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest-admin.json'), 'utf8'));
  assert.equal(m.start_url, '/admin'); assert.equal(m.id, '/admin');
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  const r = v.rewrites.find(x => x.source === '/admin');
  assert.equal(r.destination, '/api/admin-page');
  assert.equal(v.functions['api/admin-page.js'].includeFiles, 'index.html');
});
