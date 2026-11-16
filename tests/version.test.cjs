const test = require('node:test'), assert = require('node:assert/strict');

function response() {
  return { code: 0, data: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
}

test('api/version: devuelve el commit desplegado y no se guarda en caché', () => {
  const prev = process.env.VERCEL_GIT_COMMIT_SHA;
  process.env.VERCEL_GIT_COMMIT_SHA = 'abc123';
  try {
    const res = response();
    require('../api/version.js')({}, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.data, { version: 'abc123' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally { if (prev === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA; else process.env.VERCEL_GIT_COMMIT_SHA = prev; }
});
