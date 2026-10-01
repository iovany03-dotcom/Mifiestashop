const test = require('node:test'), assert = require('node:assert/strict');
const { revisarCupon, calcularDescuento, generarCodigo, CODIGO_RE } = require('../lib/cupones.js');

function response() {
  return { code: 0, data: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; }, end() { return this; } };
}

test('cupones: porcentaje, monto, mínimo, vigencia, usos y correo', () => {
  const base = { activo: true, tipo: 'porcentaje', valor: 10, minimo_compra: 0, usos: 0, usos_max: null, email: null, inicia_at: null, vence_at: null };
  assert.equal(calcularDescuento(base, 3439), 343.9);
  assert.equal(calcularDescuento({ tipo: 'monto', valor: 500 }, 300), 300); // nunca más que el subtotal
  assert.equal(revisarCupon(base, { subtotal: 100 }).descuento, 10);
  assert.match(revisarCupon({ ...base, vence_at: new Date(Date.now() - 1000).toISOString() }, { subtotal: 100 }).error, /venció/);
  assert.match(revisarCupon({ ...base, inicia_at: new Date(Date.now() + 36e5).toISOString() }, { subtotal: 100 }).error, /todavía no/);
  assert.match(revisarCupon({ ...base, usos: 1, usos_max: 1 }, { subtotal: 100 }).error, /ya se usó/);
  assert.match(revisarCupon({ ...base, minimo_compra: 500 }, { subtotal: 100 }).error, /desde \$500/);
  assert.match(revisarCupon({ ...base, email: 'a@b.com' }, { email: 'otro@b.com', subtotal: 100 }).error, /personal/);
  assert.equal(revisarCupon({ ...base, email: 'a@b.com' }, { email: ' A@B.com ', subtotal: 100 }).ok, true);
  assert.match(revisarCupon({ ...base, activo: false }, { subtotal: 100 }).error, /no existe/);
  const c = generarCodigo('vuelve');
  assert.match(c, /^VUELVE-[A-Z2-9]{6}$/); assert.ok(CODIGO_RE.test(c));
});

test('retransmisiones: teléfono para WhatsApp y liga de recuperación', () => {
  const { telefonoWhatsApp, ligaRecuperar, rellenar } = require('../api/retransmisiones.js');
  assert.equal(telefonoWhatsApp('844 494 0974'), '528444940974');
  assert.equal(telefonoWhatsApp('+52 1 844 494 0974'), '528444940974');
  assert.equal(telefonoWhatsApp('123'), null);
  const liga = ligaRecuperar([{ id: 83277, qty: 20 }, { id: 83591, qty: 1 }], 'VUELVE-ABC234');
  assert.equal(liga, 'https://www.mifiestashop.com/?carrito=83277x20.83591x1&cupon=VUELVE-ABC234&utm_source=retransmision');
  assert.equal(rellenar('Hola {nombre}, usa {cupon} ({descuento}) antes del {vence}: {liga}', { nombre: 'Cinthya', cupon: 'X1', descuento: '10%', vence: 'jueves', liga: 'L' }), 'Hola Cinthya, usa X1 (10%) antes del jueves: L');
});

test('api/retransmisiones: sin sesión no hace nada', async () => {
  const prev = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => false });
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { accion: 'cupones' } }, res);
    assert.equal(res.code, 401);
  } finally { global.fetch = prev; }
});

test('api/retransmisiones: audiencia quita a quien ya pagó después y deja uno por cliente', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const hace = h => new Date(Date.now() - h * 36e5).toISOString();
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('pedidos_online') && u.includes('Error en el pago')) return ok([
      { folio: 'WEB-1', created_at: hace(10), customer_name: 'Ana', customer_email: 'ana@x.com', customer_phone: '5511112222', total: 500, items: [{ id: 1, qty: 2, name: 'Globo' }], status: 'Pendiente' },
      { folio: 'WEB-2', created_at: hace(20), customer_name: 'Beto', customer_email: 'beto@x.com', customer_phone: '', total: 300, items: [{ id: 2, qty: 1, name: 'Vela' }], status: 'Error en el pago', mp_status_detail: 'cc_rejected_high_risk' }
    ]);
    if (u.includes('pedidos_online')) return ok([{ customer_email: 'beto@x.com', created_at: hace(5) }]); // Beto ya pagó después
    if (u.includes('carritos_web')) return ok([
      { id: 7, customer_name: 'Ana', customer_email: 'ANA@x.com', items: [{ id: 3, qty: 1, name: 'Tiara', price: 20 }], subtotal: 20, date_upd: hace(30) }, // misma Ana, más viejo
      { id: 8, customer_name: '', customer_phone: '8444940974', items: [{ id: 4, qty: 3, name: 'Pistola', price: 25 }], subtotal: 75, date_upd: hace(3) }
    ]);
    if (u.includes('retransmisiones')) return ok([{ email: 'ana@x.com', canal: 'email', estado: 'enviado', created_at: hace(1) }]);
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'audiencia', dias: 14 } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const refs = res.data.destinatarios.map(d => d.referencia);
    assert.deepEqual(refs, ['CRW-8', 'WEB-1']);
    assert.equal(res.data.destinatarios[1].ultimoContacto.canal, 'email');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/retransmisiones: WhatsApp con cupón personal regresa la liga wa.me con el código', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  const creados = [], logs = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('/pedidos_online?folio=eq.WEB-1')) return ok([{ folio: 'WEB-1', customer_name: 'Cinthya Durán', customer_email: 'c@x.com', customer_phone: '844 494 0974', items: [{ id: 83591, qty: 1, name: 'Promo Boda VIP' }] }]);
    if (u.endsWith('/cupones') && opts.method === 'POST') { const row = JSON.parse(opts.body)[0]; creados.push(row); return ok([row]); }
    if (u.endsWith('/retransmisiones') && opts.method === 'POST') { logs.push(JSON.parse(opts.body)[0]); return ok(null); }
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: {
      p_admin_password: 'x', accion: 'enviar', canal: 'whatsapp',
      destinatarios: [{ tipo: 'pedido', referencia: 'WEB-1' }],
      mensaje: 'Hola {nombre}, te regalamos {descuento} con el código {cupon} hasta el {vence}',
      cupon: { modo: 'personal', tipo: 'porcentaje', valor: 10, horas: 48, prefijo: 'BODA' }
    } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const r = res.data.resultados[0];
    assert.equal(r.ok, true);
    assert.match(r.codigo, /^BODA-/);
    assert.ok(r.whatsapp.startsWith('https://wa.me/528444940974?text='));
    const texto = decodeURIComponent(r.whatsapp.split('text=')[1]);
    assert.match(texto, /^Hola Cinthya, te regalamos 10% con el código BODA-/);
    assert.match(texto, /carrito=83591x1&cupon=BODA-/);
    assert.equal(creados[0].usos_max, 1); assert.equal(creados[0].email, 'c@x.com'); assert.ok(creados[0].vence_at);
    assert.equal(logs[0].estado, 'preparado'); assert.equal(logs[0].cupon_codigo, r.codigo);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/retransmisiones: WhatsApp con plantilla aprobada manda real vía chatbotproia (no wa.me)', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  process.env.CHATBOTPROIA_TOKEN = 'cpt_test';
  const logs = [];
  let enviado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('/pedidos_online?folio=eq.WEB-1')) return ok([{ folio: 'WEB-1', customer_name: 'Cinthya Durán', customer_email: 'c@x.com', customer_phone: '844 494 0974', items: [{ id: 83591, qty: 1, name: 'Promo Boda VIP' }] }]);
    if (u.endsWith('/retransmisiones') && opts.method === 'POST') { logs.push(JSON.parse(opts.body)[0]); return ok(null); }
    if (u.includes('panel.chatbotproia.com/api/contacts/find_by_custom_field')) return ok({ data: [] }); // nunca le ha escrito al bot
    if (u.includes('panel.chatbotproia.com/api/contacts') && opts.method === 'POST' && !u.includes('/send/whatsapp')) {
      assert.equal(JSON.parse(opts.body).phone, '528444940974');
      return ok({ success: true, id: 'contact-uuid-1' });
    }
    if (u.includes('panel.chatbotproia.com/api/contacts/contact-uuid-1/send/whatsapp')) {
      enviado = JSON.parse(opts.body);
      return ok({ ok: true, messageIds: ['wamid.1'] });
    }
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: {
      p_admin_password: 'x', accion: 'enviar', canal: 'whatsapp',
      destinatarios: [{ tipo: 'pedido', referencia: 'WEB-1' }],
      cupon: { modo: 'ninguno' },
      plantillaWa: { name: 'cupon_carrito', language: 'es_MX', mapping: ['nombre', 'liga'] }
    } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    const r = res.data.resultados[0];
    assert.equal(r.ok, true);
    assert.equal(r.whatsapp, undefined);
    assert.equal(enviado.template.name, 'cupon_carrito');
    assert.equal(enviado.template.language, 'es_MX');
    assert.equal(enviado.template.parameters[0], 'Cinthya');
    assert.match(enviado.template.parameters[1], /^https:\/\/www\.mifiestashop\.com\/\?carrito=83591x1/);
    assert.equal(logs[0].estado, 'enviado');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.CHATBOTPROIA_TOKEN; }
});

test('api/retransmisiones: plantillas_whatsapp solo regresa las aprobadas por Meta', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  process.env.CHATBOTPROIA_TOKEN = 'cpt_test';
  global.fetch = async (url) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('panel.chatbotproia.com/api/whatsapp/message-templates')) return ok({
      data: [
        { name: 'cupon_carrito', language: 'es_MX', status: 'APPROVED', category: 'MARKETING', body_text: 'Hola {{1}}, {{2}}', param_count: 2 },
        { name: 'en_revision', language: 'es_MX', status: 'PENDING', category: 'MARKETING', body_text: 'x', param_count: 0 }
      ]
    });
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'plantillas_whatsapp' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.plantillas.length, 1);
    assert.equal(res.data.plantillas[0].name, 'cupon_carrito');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.CHATBOTPROIA_TOKEN; }
});

test('api/retransmisiones: auto_config_guardar exige plantilla si se activa, y auto_config_leer regresa lo último guardado', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let guardado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('rpc_check_session')) return ok(true);
    if (u.includes('/ajustes_retransmision_auto') && opts.method === 'POST') { guardado = JSON.parse(opts.body)[0]; return ok(null); }
    if (u.includes('/ajustes_retransmision_auto')) return ok(guardado ? [guardado] : []);
    return ok([]);
  };
  try {
    const sinPlantilla = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'auto_config_guardar', activo: true, horas_espera: 24 } }, sinPlantilla);
    assert.equal(sinPlantilla.code, 400);
    assert.match(sinPlantilla.data.error, /Elige una plantilla/);

    const res = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: {
      p_admin_password: 'x', accion: 'auto_config_guardar', activo: true, horas_espera: 36, dias_buscar: 20,
      plantilla_nombre: 'cupon_carrito', plantilla_idioma: 'es_MX', plantilla_mapping: ['nombre', 'liga'],
      cupon_tipo: 'porcentaje', cupon_valor: 15, cupon_minimo: 0, cupon_vigencia_horas: 72, cupon_prefijo: 'vuelve'
    } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(guardado.horas_espera, 36);
    assert.equal(guardado.cupon_prefijo, 'VUELVE');

    const leer = response();
    await require('../api/retransmisiones.js')({ method: 'POST', body: { p_admin_password: 'x', accion: 'auto_config_leer' } }, leer);
    assert.equal(leer.code, 200);
    assert.equal(leer.data.config.plantilla_nombre, 'cupon_carrito');
    assert.equal(leer.data.config.activo, true);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/cron-retransmision-auto: sin config activa no manda nada', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  global.fetch = async (url) => {
    const u = String(url);
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('/ajustes_retransmision_auto')) return ok([]);
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/cron-retransmision-auto.js')({ headers: {} }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.activo, false);
    assert.equal(res.data.enviados, 0);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('api/cron-retransmision-auto: manda solo a quien ya cumplió las horas de espera y nunca se le había contactado', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  process.env.CHATBOTPROIA_TOKEN = 'cpt_test';
  const hace = h => new Date(Date.now() - h * 36e5).toISOString();
  const enviosWa = [];
  const logs = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const ok = d => ({ ok: true, json: async () => d, text: async () => '' });
    if (u.includes('/ajustes_retransmision_auto')) return ok([{
      id: 1, activo: true, horas_espera: 24, dias_buscar: 14,
      plantilla_nombre: 'cupon_carrito', plantilla_idioma: 'es_MX', plantilla_mapping: ['nombre', 'liga'],
      cupon_tipo: null, cupon_minimo: 0, cupon_vigencia_horas: 48, cupon_prefijo: 'AUTO'
    }]);
    if (u.includes('pedidos_online') && u.includes('Error en el pago')) return ok([
      { folio: 'WEB-1', created_at: hace(30), customer_name: 'Ana', customer_email: 'ana@x.com', customer_phone: '5511112222', total: 500, items: [{ id: 1, qty: 2, name: 'Globo' }], status: 'Pendiente' },
      { folio: 'WEB-2', created_at: hace(5), customer_name: 'Beto', customer_email: 'beto@x.com', customer_phone: '5522223333', total: 300, items: [{ id: 2, qty: 1, name: 'Vela' }], status: 'Pendiente' }
    ]);
    if (u.includes('pedidos_online') && !u.includes('folio=eq')) return ok([]);
    if (u.includes('/pedidos_online?folio=eq.WEB-1')) return ok([{ folio: 'WEB-1', customer_name: 'Ana', customer_email: 'ana@x.com', customer_phone: '5511112222', items: [{ id: 1, qty: 2, name: 'Globo' }] }]);
    if (u.includes('carritos_web')) return ok([]);
    if (u.includes('retransmisiones') && opts.method === 'POST') { logs.push(JSON.parse(opts.body)[0]); return ok(null); }
    if (u.includes('retransmisiones')) return ok([]); // sin contactos previos ni historial
    if (u.includes('panel.chatbotproia.com/api/contacts/find_by_custom_field')) return ok({ data: [] });
    if (u.includes('panel.chatbotproia.com/api/contacts') && opts.method === 'POST' && !u.includes('/send/whatsapp')) return ok({ success: true, id: 'contact-uuid-1' });
    if (u.includes('panel.chatbotproia.com/api/contacts/contact-uuid-1/send/whatsapp')) { enviosWa.push(JSON.parse(opts.body)); return ok({ ok: true, messageIds: ['wamid.1'] }); }
    return ok([]);
  };
  try {
    const res = response();
    await require('../api/cron-retransmision-auto.js')({ headers: {} }, res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.enviados, 1); // solo WEB-1 (30h) pasó las 24h de espera; WEB-2 (5h) no.
    assert.equal(enviosWa.length, 1);
    assert.equal(enviosWa[0].template.parameters[0], 'Ana');
    assert.equal(logs[0].referencia, 'WEB-1');
    assert.equal(logs[0].enviado_por, 'Automático (programado)');
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.CHATBOTPROIA_TOKEN; }
});

test('api/crear-pedido: aplica el cupón con el subtotal del servidor y lo guarda en el pedido', async () => {
  const prev = global.fetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sr';
  let guardado = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    if (u.includes('catalogo_productos')) return ok([{ id: 83591, name: 'Promo Boda VIP', sku: 'x', price: 2799, active: true }]);
    if (u.includes('/cupones?codigo=eq.BODA-ABC234')) return ok([{ codigo: 'BODA-ABC234', tipo: 'porcentaje', valor: 10, minimo_compra: 0, usos: 0, usos_max: 1, email: 'c@x.com', activo: true, vence_at: new Date(Date.now() + 36e5).toISOString() }]);
    if (u.includes('/cupones?codigo=eq.')) return ok([]);
    if (u.includes('pedidos_online') && opts.method === 'POST') { guardado = JSON.parse(opts.body); return ok(null); }
    return ok([]);
  };
  const pedido = (extra) => ({ method: 'POST', body: {
    items: [{ id: 83591, qty: 1, price: 1 }], customer_name: 'Cinthya', customer_email: 'c@x.com', customer_phone: '8444940974',
    address: 'Calle 1', colonia: 'Centro', municipio: 'Saltillo', estado: 'Coahuila', cp: '25019', shipping_cost: 0, payment_method: 'Mercado Pago', ...extra
  } });
  try {
    const res = response();
    await require('../api/crear-pedido.js')(pedido({ coupon_code: ' boda-abc234 ' }), res);
    assert.equal(res.code, 200, JSON.stringify(res.data));
    assert.equal(res.data.descuento, 279.9);
    assert.equal(res.data.total, 2519.1);
    assert.equal(guardado.cupon_codigo, 'BODA-ABC234');
    assert.equal(guardado.discount_amount, 279.9);

    const res2 = response();
    await require('../api/crear-pedido.js')(pedido({ coupon_code: 'NOEXISTE' }), res2);
    assert.equal(res2.code, 400);
    assert.equal(res2.data.cuponInvalido, true);

    const res3 = response();
    await require('../api/crear-pedido.js')(pedido({ coupon_code: 'BODA-ABC234', customer_email: 'otro@x.com' }), res3);
    assert.equal(res3.code, 400);
    assert.match(res3.data.error, /personal/);
  } finally { global.fetch = prev; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});
