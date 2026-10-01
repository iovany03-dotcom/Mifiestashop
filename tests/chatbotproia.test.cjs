const test = require('node:test'), assert = require('node:assert/strict');

function response() {
  return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
}

test('lib/chatbotproia: guarda el token en Supabase y lo vuelve a leer (sin exponerlo)', async () => {
  const { guardarToken, chatbotproiaConfigured } = require('../lib/chatbotproia.js');
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let guardado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/ajustes_chatbotproia') && opts.method === 'POST') {
      guardado = JSON.parse(opts.body)[0];
      return { ok: true, json: async () => null };
    }
    if (u.includes('/rest/v1/ajustes_chatbotproia')) {
      return { ok: true, json: async () => (guardado ? [{ token: guardado.token }] : []) };
    }
    return { ok: true, json: async () => ([]) };
  };
  try {
    assert.equal(await chatbotproiaConfigured(), false);
    await guardarToken('  cpt_live_abc123  ');
    assert.equal(guardado.token, 'cpt_live_abc123');
    assert.equal(await chatbotproiaConfigured(), true);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('lib/chatbotproia: sin token guardado ni de respaldo, cpListarPlantillas explica qué falta', async () => {
  const { cpListarPlantillas } = require('../lib/chatbotproia.js');
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async () => ({ ok: true, json: async () => ([]) });
  try {
    await assert.rejects(cpListarPlantillas(), /Todavía no has configurado el token/);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/retransmisiones: chatbotproia_guardar_token guarda y prueba la conexión', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let tokenGuardado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('/rest/v1/ajustes_chatbotproia') && opts.method === 'POST') { tokenGuardado = JSON.parse(opts.body)[0].token; return ok(null); }
    if (u.includes('/rest/v1/ajustes_chatbotproia')) return ok(tokenGuardado ? [{ token: tokenGuardado }] : []);
    if (u.includes('panel.chatbotproia.com/api/whatsapp/message-templates')) {
      assert.equal(opts.headers['X-ACCESS-TOKEN'], 'cpt_live_nuevo');
      return ok({ data: [{ name: 'cupon_carrito', language: 'es_MX', status: 'APPROVED', body_text: 'Hola {{1}}', param_count: 1 }] });
    }
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'chatbotproia_guardar_token', token: 'cpt_live_nuevo' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.plantillas.length, 1);
    assert.equal(tokenGuardado, 'cpt_live_nuevo');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/retransmisiones: chatbotproia_guardar_token igual guarda el token aunque la prueba falle', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let tokenGuardado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('/rest/v1/ajustes_chatbotproia') && opts.method === 'POST') { tokenGuardado = JSON.parse(opts.body)[0].token; return ok(null); }
    if (u.includes('/rest/v1/ajustes_chatbotproia')) return ok(tokenGuardado ? [{ token: tokenGuardado }] : []);
    if (u.includes('panel.chatbotproia.com/api/whatsapp/message-templates')) return { ok: false, json: async () => ({ error: 'Token de acceso inválido o ausente.' }) };
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'chatbotproia_guardar_token', token: 'cpt_live_malo' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, false);
    assert.match(res.data.error, /inválido o ausente/);
    assert.equal(tokenGuardado, 'cpt_live_malo');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/retransmisiones: chatbotproia_estado nunca regresa el token, solo si ya hay uno', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async (url) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('/rest/v1/ajustes_chatbotproia')) return ok([{ token: 'cpt_live_secreto' }]);
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'chatbotproia_estado' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data, { configurado: true });
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('lib/chatbotproia: normalizarPlantilla saca texto y # de variables del formato "components" de Meta', () => {
  const { normalizarPlantilla } = require('../lib/chatbotproia.js');
  const a = normalizarPlantilla({ name: 'carrito_per', components: [{ type: 'HEADER', text: 'Hola' }, { type: 'BODY', text: 'Hola {{1}}, tu cupón {{2}}' }] });
  assert.equal(a.body_text, 'Hola {{1}}, tu cupón {{2}}');
  assert.equal(a.param_count, 2);
  assert.equal(normalizarPlantilla({ components: [{ type: 'BODY', text: 'x', example: { body_text: [['a', 'b', 'c']] } }] }).param_count, 3);
  assert.equal(normalizarPlantilla({ body_text: 'Hola {{1}}', param_count: 1 }).param_count, 1);
  assert.equal(normalizarPlantilla({ name: 'sin_datos' }).param_count, 0);
});
