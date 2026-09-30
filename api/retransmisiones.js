// Vercel serverless function: herramienta "Retransmisiones" del admin.
// Mensajes (correo o WhatsApp) y cupones con vigencia para los clientes que
// dejaron su carrito abandonado o no terminaron de pagar su pedido.
// Requiere sesión (admin o personal) y usa la llave de servicio.
//
// POST { ...creds, accion, ... }
//   'audiencia'  { dias }  -> { destinatarios: [...] }
//       pedidos web en Pendiente / Pendiente de pago / Error en el pago y
//       carritos abandonados (más de 1 h sin moverse) con correo o
//       teléfono, sin los que ya compraron después. Uno por cliente.
//   'enviar'     { canal: 'email'|'whatsapp', destinatarios: [{ tipo, referencia }],
//                  asunto, mensaje, cupon: { modo: 'ninguno'|'personal'|'existente',
//                  tipo, valor, minimo, horas, codigo, prefijo } }
//       -> { resultados: [{ referencia, ok, codigo, whatsapp, error }] }
//       El mensaje admite {nombre}, {cupon}, {descuento}, {vence} y {liga}.
//       WhatsApp no se puede mandar solo (no hay API de WhatsApp Business):
//       se regresa la liga wa.me con el texto listo para abrirla.
//   'cupones'    -> { cupones: [...] }
//   'crear_cupon' { codigo?, prefijo?, tipo, valor, minimo, inicia, vence, usos_max, email, descripcion }
//   'cupon_activo' { codigo, activo }
//   'historial'  -> { historial: [...] }
//   WhatsApp automático por chatbotproia (lib/chatbotproia.js):
//   'enviar' con canal 'chatbot' y plantilla: { nombre, idioma, variables: ['nombre','cupon',…], texto? }
//   'chatbot_estado' / 'chatbot_guardar' { url, token } / 'chatbot_quitar'
//   'plantillas' -> plantillas de WhatsApp del bot (Meta) + qué variable va en cada {{n}}
//   'crear_plantilla' { nombre, categoria, texto con {nombre} {cupon}… } / 'mapear_plantilla' { nombre, idioma, variables }
const { layout, escapeHtml, sendHtml, smtpConfigured } = require('../lib/correo.js');
const { CODIGO_RE, normalizarCodigo, generarCodigo, etiquetaCupon } = require('../lib/cupones.js');
const chatbot = require('../lib/chatbotproia.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const SITIO = 'https://www.mifiestashop.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ESTADOS_SIN_PAGAR = ['Pendiente', 'Pendiente de pago', 'Error en el pago'];
const ESTADOS_PAGADOS = ['Pago aceptado', 'Pagado', 'En preparación', 'Enviado', 'Entregado'];
const MAX_ENVIO = 40;

async function checkSession(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_admin_password: body.p_admin_password ?? null,
      p_staff_email: body.p_staff_email ?? null,
      p_staff_pin: body.p_staff_pin ?? null
    })
  });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

function sb(key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    async get(path) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
      if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return r.json();
    },
    async post(table, rows, prefer = 'return=representation') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: prefer }, body: JSON.stringify(rows)
      });
      if (!r.ok) throw new Error(`${table} -> HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return prefer.includes('representation') ? r.json() : null;
    },
    async patch(path, data) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return r.json();
    }
  };
}

const inList = arr => `(${arr.map(v => `"${v}"`).join(',')})`;
const emailKey = e => String(e || '').trim().toLowerCase();
const phoneDigits = p => String(p || '').replace(/\D/g, '');

// Teléfono mexicano -> número para wa.me (52 + 10 dígitos). null si no se
// puede interpretar.
function telefonoWhatsApp(p) {
  let d = phoneDigits(p);
  if (d.length === 10) return '52' + d;
  if (d.length === 12 && d.startsWith('52')) return d;
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return null;
}

function itemsDe(items) {
  return (Array.isArray(items) ? items : [])
    .map(it => ({ id: parseInt(it.id ?? it.id_product, 10), qty: Math.max(1, parseInt(it.qty, 10) || 1), name: it.name || '', price: Number(it.price) || 0 }))
    .filter(it => Number.isInteger(it.id) && it.id > 0)
    .slice(0, 50);
}

// Liga que vuelve a llenar el carrito del cliente (en cualquier
// dispositivo) y deja el cupón listo para el checkout.
function ligaRecuperar(items, codigo) {
  const params = new URLSearchParams();
  if (items.length) params.set('carrito', items.map(it => `${it.id}x${it.qty}`).join('.'));
  if (codigo) params.set('cupon', codigo);
  params.set('utm_source', 'retransmision');
  return `${SITIO}/?${params.toString()}`;
}

function fechaMx(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
}

function rellenar(texto, v) {
  return String(texto || '')
    .replace(/\{nombre\}/g, v.nombre || '')
    .replace(/\{cupon\}/g, v.cupon || '')
    .replace(/\{descuento\}/g, v.descuento || '')
    .replace(/\{vence\}/g, v.vence || '')
    .replace(/\{liga\}/g, v.liga || '');
}

function correoHtml({ mensaje, items, cupon, liga }) {
  const parrafos = escapeHtml(mensaje).split(/\n{2,}/).map(p => `<p style="line-height:1.6;">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const lista = items.length ? `
    <div style="border:1px solid #f0e6ef; border-radius:12px; padding:12px 14px; margin:16px 0;">
      <div style="font-weight:700; margin-bottom:6px;">Lo que dejaste en tu carrito:</div>
      ${items.slice(0, 12).map(it => `<div style="font-size:14px; padding:3px 0;">${it.qty} × ${escapeHtml(it.name || 'Producto #' + it.id)}</div>`).join('')}
      ${items.length > 12 ? `<div style="font-size:13px; color:#8b7d97;">y ${items.length - 12} productos más</div>` : ''}
    </div>` : '';
  const caja = cupon ? `
    <div style="border:2px dashed #d3007b; border-radius:12px; padding:14px; margin:18px 0; text-align:center; background:#fff5fa;">
      <div style="font-size:13px; color:#8b7d97;">Tu cupón de ${escapeHtml(cupon.descuento)}</div>
      <div style="font-size:26px; font-weight:800; letter-spacing:2px; color:#d3007b; margin:6px 0;">${escapeHtml(cupon.codigo)}</div>
      ${cupon.vence ? `<div style="font-size:13px; color:#2e1065;">Válido hasta el <b>${escapeHtml(cupon.vence)}</b></div>` : ''}
      ${cupon.minimo ? `<div style="font-size:12px; color:#8b7d97;">En compras desde ${escapeHtml(cupon.minimo)} (sin envío)</div>` : ''}
    </div>` : '';
  return layout(`
    ${parrafos}
    ${caja}
    ${lista}
    <div style="text-align:center; margin:22px 0;">
      <a href="${escapeHtml(liga)}" style="display:inline-block; background:#d3007b; color:#fff; text-decoration:none; font-weight:700; padding:12px 26px; border-radius:24px;">Terminar mi compra</a>
    </div>`);
}

// ---------- Audiencia ----------
async function audiencia(db, dias) {
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const haceUnaHora = new Date(Date.now() - 36e5).toISOString();
  const [pedidos, pagados, carritos, contactos] = await Promise.all([
    db.get(`pedidos_online?created_at=gte.${desde}&status=in.${encodeURIComponent(inList(ESTADOS_SIN_PAGAR))}&select=folio,created_at,customer_name,customer_email,customer_phone,total,items,status,mp_status_detail&order=created_at.desc&limit=500`),
    db.get(`pedidos_online?created_at=gte.${desde}&status=in.${encodeURIComponent(inList(ESTADOS_PAGADOS))}&select=customer_email,customer_phone,created_at&limit=2000`),
    db.get(`carritos_web?date_upd=gte.${desde}&date_upd=lte.${haceUnaHora}&order_reference=is.null&or=(customer_email.not.is.null,customer_phone.not.is.null)&select=id,customer_name,customer_email,customer_phone,items,subtotal,date_upd&order=date_upd.desc&limit=500`),
    db.get(`retransmisiones?created_at=gte.${new Date(Date.now() - 90 * 864e5).toISOString()}&select=email,telefono,referencia,canal,estado,cupon_codigo,created_at&order=created_at.desc&limit=2000`)
  ]);

  // Última compra pagada por correo / teléfono: quien ya compró después
  // de abandonar no recibe mensaje.
  const ultimaCompra = new Map();
  for (const p of pagados) {
    for (const k of [emailKey(p.customer_email), phoneDigits(p.customer_phone).slice(-10)]) {
      if (!k) continue;
      const t = new Date(p.created_at).getTime();
      if (!ultimaCompra.has(k) || ultimaCompra.get(k) < t) ultimaCompra.set(k, t);
    }
  }
  const comproDespues = (email, tel, fecha) => {
    const t = new Date(fecha).getTime();
    return [emailKey(email), phoneDigits(tel).slice(-10)].some(k => k && ultimaCompra.has(k) && ultimaCompra.get(k) > t);
  };

  const lista = [];
  for (const p of pedidos) {
    if (comproDespues(p.customer_email, p.customer_phone, p.created_at)) continue;
    const items = itemsDe(p.items);
    lista.push({
      tipo: 'pedido', referencia: p.folio, fecha: p.created_at, nombre: p.customer_name || '',
      email: p.customer_email || '', telefono: p.customer_phone || '', total: Number(p.total) || 0,
      estado: p.status, motivo: p.mp_status_detail || null, piezas: items.reduce((s, i) => s + i.qty, 0),
      productos: items.slice(0, 5).map(i => i.name).filter(Boolean)
    });
  }
  for (const c of carritos) {
    if (comproDespues(c.customer_email, c.customer_phone, c.date_upd)) continue;
    const items = itemsDe(c.items);
    if (!items.length) continue;
    lista.push({
      tipo: 'carrito', referencia: `CRW-${c.id}`, fecha: c.date_upd, nombre: c.customer_name || '',
      email: c.customer_email || '', telefono: c.customer_phone || '',
      total: Number(c.subtotal) || items.reduce((s, i) => s + i.price * i.qty, 0), estado: 'Carrito abandonado', motivo: null,
      piezas: items.reduce((s, i) => s + i.qty, 0), productos: items.slice(0, 5).map(i => i.name).filter(Boolean)
    });
  }

  // Uno por cliente (el más reciente): alguien con carrito y pedido
  // aparece una sola vez.
  lista.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const vistos = new Set();
  const unicos = lista.filter(d => {
    const keys = [emailKey(d.email), phoneDigits(d.telefono).slice(-10)].filter(Boolean);
    if (!keys.length || keys.some(k => vistos.has(k))) return false;
    keys.forEach(k => vistos.add(k));
    return true;
  });

  // Último mensaje que ya se le mandó.
  for (const d of unicos) {
    const e = emailKey(d.email), t = phoneDigits(d.telefono).slice(-10);
    const c = contactos.find(x => x.referencia === d.referencia || (e && emailKey(x.email) === e) || (t && phoneDigits(x.telefono).slice(-10) === t));
    d.ultimoContacto = c ? { fecha: c.created_at, canal: c.canal, estado: c.estado, cupon: c.cupon_codigo } : null;
  }
  return unicos;
}

// ---------- Cupones ----------
function datosCupon(c, extra) {
  const tipo = c.tipo === 'monto' ? 'monto' : 'porcentaje';
  const valor = Number(c.valor);
  if (!(valor > 0) || (tipo === 'porcentaje' && valor > 100)) throw new Error('El valor del cupón no es válido (porcentaje de 1 a 100 o un monto mayor a 0).');
  const minimo = Math.max(0, Number(c.minimo) || 0);
  let vence = null;
  if (c.vence) vence = new Date(c.vence);
  else if (Number(c.horas) > 0) vence = new Date(Date.now() + Number(c.horas) * 36e5);
  if (vence && (isNaN(vence) || vence <= new Date())) throw new Error('La fecha de vencimiento tiene que ser en el futuro.');
  const inicia = c.inicia ? new Date(c.inicia) : new Date();
  if (isNaN(inicia)) throw new Error('La fecha de inicio no es válida.');
  const usosMax = c.usos_max ? parseInt(c.usos_max, 10) : null;
  return {
    tipo, valor, minimo_compra: minimo, vence_at: vence ? vence.toISOString() : null, inicia_at: inicia.toISOString(),
    usos_max: usosMax > 0 ? usosMax : null, ...extra
  };
}

async function crearCupon(db, datos, codigoPedido, prefijo) {
  for (let intento = 0; intento < 4; intento++) {
    const codigo = codigoPedido ? normalizarCodigo(codigoPedido) : generarCodigo(prefijo);
    if (!CODIGO_RE.test(codigo)) throw new Error('El código solo puede tener letras, números y guiones (3 a 30).');
    try {
      const rows = await db.post('cupones', [{ ...datos, codigo }]);
      return rows[0];
    } catch (e) {
      if (/409|duplicate|23505/.test(e.message)) {
        if (codigoPedido) throw new Error(`Ya existe un cupón con el código ${codigo}.`);
        continue;
      }
      throw e;
    }
  }
  throw new Error('No se pudo generar un código de cupón único.');
}

function textoCupon(c) {
  return {
    codigo: c.codigo,
    descuento: etiquetaCupon(c).replace(' de descuento', ''),
    vence: fechaMx(c.vence_at),
    minimo: Number(c.minimo_compra) > 0 ? `$${Number(c.minimo_compra).toFixed(2)}` : ''
  };
}

// ---------- Envío ----------
async function cargarDestinatario(db, d) {
  const ref = String(d.referencia || '');
  if (d.tipo === 'pedido' && /^[A-Z]+-\d+$/.test(ref)) {
    const rows = await db.get(`pedidos_online?folio=eq.${encodeURIComponent(ref)}&select=folio,customer_name,customer_email,customer_phone,items,total&limit=1`);
    const p = rows[0];
    if (!p) return null;
    return { tipo: 'pedido', referencia: p.folio, nombre: p.customer_name || '', email: p.customer_email || '', telefono: p.customer_phone || '', items: itemsDe(p.items), total: Number(p.total) || 0 };
  }
  const m = ref.match(/^CRW-(\d+)$/);
  if (d.tipo === 'carrito' && m) {
    const rows = await db.get(`carritos_web?id=eq.${m[1]}&select=id,customer_name,customer_email,customer_phone,items,subtotal&limit=1`);
    const c = rows[0];
    if (!c) return null;
    const items = itemsDe(c.items);
    return { tipo: 'carrito', referencia: ref, nombre: c.customer_name || '', email: c.customer_email || '', telefono: c.customer_phone || '', items, total: Number(c.subtotal) || items.reduce((s, i) => s + i.price * i.qty, 0) };
  }
  return null;
}

// ---------- chatbotproia ----------
async function chatbotConfig(db) {
  const rows = await db.get('integraciones?clave=eq.chatbotproia&select=config&limit=1');
  const c = rows[0] && rows[0].config;
  return c && c.token ? { url: c.url || chatbot.URL_DEFAULT, token: c.token } : null;
}

// Valores de las variables para el {{n}} de una plantilla de WhatsApp. Meta
// rechaza parámetros vacíos: se pone un texto neutro.
function valorVariable(v, datos) {
  const val = String(datos[v] ?? '').replace(/\s+/g, ' ').trim();
  if (val) return val;
  return v === 'nombre' ? 'cliente' : '-';
}

async function enviar(db, body, enviadoPor) {
  const canal = ['whatsapp', 'chatbot'].includes(body.canal) ? body.canal : 'email';
  const destinos = (Array.isArray(body.destinatarios) ? body.destinatarios : []).slice(0, MAX_ENVIO);
  if (!destinos.length) throw new Error('Selecciona al menos un cliente.');
  const mensaje = String(body.mensaje || '').slice(0, 3000);
  const asunto = String(body.asunto || '').slice(0, 150) || '¡Tu carrito te está esperando!';
  if (canal !== 'chatbot' && !mensaje.trim()) throw new Error('Escribe el mensaje.');
  if (canal === 'email' && !smtpConfigured()) throw new Error('El correo (SMTP) no está configurado en Vercel.');

  // WhatsApp por chatbotproia: fuera de las 24 h desde el último mensaje del
  // cliente Meta solo acepta plantillas aprobadas, así que siempre se manda
  // una plantilla con sus {{n}} llenos con las variables elegidas.
  let bot = null, plantilla = null;
  if (canal === 'chatbot') {
    bot = await chatbotConfig(db);
    if (!bot) throw new Error('chatbotproia no está conectado. Pon la llave en la pestaña Plantillas WhatsApp.');
    const p = body.plantilla || {};
    const variables = (Array.isArray(p.variables) ? p.variables : []).map(v => String(v));
    if (!p.nombre) throw new Error('Elige la plantilla de WhatsApp.');
    if (variables.some(v => !(v in chatbot.VARIABLES))) throw new Error('Falta indicar qué va en cada {{n}} de la plantilla.');
    plantilla = { nombre: String(p.nombre), idioma: String(p.idioma || 'es_MX'), variables, texto: String(p.texto || '') };
  }

  const cfg = body.cupon || { modo: 'ninguno' };
  if (plantilla && cfg.modo === 'ninguno' && plantilla.variables.some(v => ['cupon', 'descuento', 'vence'].includes(v))) {
    throw new Error('La plantilla lleva cupón: elige un cupón o usa otra plantilla.');
  }
  let cuponComun = null;
  if (cfg.modo === 'existente') {
    const rows = await db.get(`cupones?codigo=eq.${encodeURIComponent(normalizarCodigo(cfg.codigo))}&select=*&limit=1`);
    cuponComun = rows[0];
    if (!cuponComun || !cuponComun.activo) throw new Error('Ese cupón no existe o está desactivado.');
    if (cuponComun.vence_at && new Date(cuponComun.vence_at) <= new Date()) throw new Error('Ese cupón ya venció.');
  } else if (cfg.modo === 'personal') {
    datosCupon(cfg, {}); // valida antes de mandar nada
  }

  const resultados = [];
  for (const d of destinos) {
    const r = { referencia: d.referencia, ok: false };
    try {
      const dest = await cargarDestinatario(db, d);
      if (!dest) throw new Error('No se encontró el pedido o carrito.');
      if (canal === 'email' && !EMAIL_RE.test(dest.email)) throw new Error('No tiene correo.');
      const wa = canal !== 'email' ? telefonoWhatsApp(dest.telefono) : null;
      if (canal !== 'email' && !wa) throw new Error('No tiene un teléfono válido.');

      let cupon = cuponComun;
      if (cfg.modo === 'personal') {
        cupon = await crearCupon(db, datosCupon(cfg, {
          usos_max: 1, email: EMAIL_RE.test(dest.email) ? dest.email.trim().toLowerCase() : null,
          origen: 'retransmision', creado_por: enviadoPor,
          descripcion: `Retransmisión a ${dest.nombre || dest.email || dest.telefono} (${dest.referencia})`
        }), null, cfg.prefijo || 'VUELVE');
      }
      const tc = cupon ? textoCupon(cupon) : null;
      const liga = ligaRecuperar(dest.items, cupon && cupon.codigo);
      const nombre = String(dest.nombre || '').trim().split(/\s+/)[0] || '';
      const texto = rellenar(mensaje, { nombre, cupon: tc ? tc.codigo : '', descuento: tc ? tc.descuento : '', vence: tc ? tc.vence : '', liga });

      const log = {
        canal, tipo_origen: dest.tipo, referencia: dest.referencia, nombre: dest.nombre || null,
        email: dest.email || null, telefono: dest.telefono || null, asunto: canal === 'email' ? rellenar(asunto, { nombre }) : (canal === 'chatbot' ? `Plantilla ${plantilla.nombre}` : null),
        mensaje: texto, cupon_codigo: cupon ? cupon.codigo : null, enviado_por: enviadoPor
      };
      if (canal === 'email') {
        try {
          await sendHtml(dest.email, log.asunto, correoHtml({ mensaje: texto, items: dest.items, cupon: tc, liga }));
          log.estado = 'enviado';
        } catch (e) {
          log.estado = 'error'; log.error = String(e.message).slice(0, 300);
        }
      } else if (canal === 'chatbot') {
        const datos = { nombre, cupon: tc && tc.codigo, descuento: tc && tc.descuento, vence: tc && tc.vence, liga, total: `$${(Number(dest.total) || 0).toFixed(2)}` };
        const parametros = plantilla.variables.map(v => valorVariable(v, datos));
        log.mensaje = plantilla.texto
          ? plantilla.texto.replace(/\{\{(\d+)\}\}/g, (m, n) => parametros[Number(n) - 1] ?? m)
          : `[Plantilla ${plantilla.nombre}] ${parametros.join(' | ')}`;
        try {
          const resp = await chatbot.llamar(bot, 'POST', 'whatsapp/send-to-phone', {
            phone: wa, first_name: nombre || undefined, email: EMAIL_RE.test(dest.email) ? dest.email : undefined,
            template: { name: plantilla.nombre, language: plantilla.idioma, parameters: parametros }
          });
          log.estado = 'enviado';
          r.contactoNuevo = !!resp.contact_created;
        } catch (e) {
          log.estado = 'error'; log.error = String(e.message).slice(0, 300);
        }
      } else {
        // El texto ya lleva la liga si el mensaje usa {liga}; si no, se agrega.
        const final = texto.includes(liga) ? texto : `${texto}\n\n${liga}`;
        log.mensaje = final;
        log.estado = 'preparado';
        r.whatsapp = `https://wa.me/${wa}?text=${encodeURIComponent(final)}`;
      }
      await db.post('retransmisiones', [log], 'return=minimal');
      r.ok = log.estado !== 'error';
      r.codigo = cupon ? cupon.codigo : null;
      if (log.error) r.error = log.error;
    } catch (e) {
      r.error = e.message;
    }
    resultados.push(r);
  }
  return resultados;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  let ok = false;
  try { ok = await checkSession(body); } catch (e) { ok = false; }
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' }); return; }
  const db = sb(key);
  const enviadoPor = String(body.enviado_por || body.p_staff_email || 'Administrador').slice(0, 100);

  try {
    switch (body.accion) {
      case 'audiencia': {
        const dias = Math.min(90, Math.max(1, parseInt(body.dias, 10) || 14));
        res.status(200).json({ destinatarios: await audiencia(db, dias) });
        return;
      }
      case 'enviar':
        res.status(200).json({ resultados: await enviar(db, body, enviadoPor) });
        return;
      case 'cupones':
        res.status(200).json({ cupones: await db.get('cupones?select=*&order=created_at.desc&limit=300') });
        return;
      case 'crear_cupon': {
        const datos = datosCupon(body, {
          email: EMAIL_RE.test(String(body.email || '').trim()) ? String(body.email).trim().toLowerCase() : null,
          descripcion: String(body.descripcion || '').slice(0, 200) || null,
          origen: 'manual', creado_por: enviadoPor
        });
        const cupon = await crearCupon(db, datos, body.codigo ? body.codigo : null, body.prefijo);
        res.status(200).json({ cupon });
        return;
      }
      case 'cupon_activo': {
        const codigo = normalizarCodigo(body.codigo);
        if (!CODIGO_RE.test(codigo)) { res.status(400).json({ error: 'Código inválido' }); return; }
        const rows = await db.patch(`cupones?codigo=eq.${encodeURIComponent(codigo)}`, { activo: !!body.activo });
        res.status(200).json({ cupon: rows[0] || null });
        return;
      }
      case 'chatbot_estado': {
        const c = await chatbotConfig(db);
        if (!c) { res.status(200).json({ conectado: false, url: chatbot.URL_DEFAULT }); return; }
        let cuenta = null, error = null;
        try { cuenta = await chatbot.llamar(c, 'GET', 'accounts/me'); } catch (e) { error = e.message; }
        res.status(200).json({ conectado: true, url: c.url, tokenFinal: c.token.slice(-4), cuenta: cuenta ? { nombre: cuenta.name, contactos: cuenta.total_users, activa: cuenta.active } : null, error });
        return;
      }
      case 'chatbot_guardar': {
        const actual = await chatbotConfig(db);
        const url = chatbot.limpiarUrl(body.url);
        const token = String(body.token || '').trim() || (actual && actual.token);
        if (!token) throw new Error('Pega la llave (X-ACCESS-TOKEN) de la cuenta Mi Fiestashop en chatbotproia.');
        // Se prueba antes de guardar: una llave equivocada nunca queda guardada.
        const cuenta = await chatbot.llamar({ url, token }, 'GET', 'accounts/me');
        await db.post('integraciones?on_conflict=clave', [{ clave: 'chatbotproia', config: { url, token }, actualizado_por: enviadoPor, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
        res.status(200).json({ conectado: true, url, tokenFinal: token.slice(-4), cuenta: { nombre: cuenta.name, contactos: cuenta.total_users, activa: cuenta.active } });
        return;
      }
      case 'chatbot_quitar': {
        await db.patch('integraciones?clave=eq.chatbotproia', { config: {}, actualizado_por: enviadoPor, updated_at: new Date().toISOString() });
        res.status(200).json({ conectado: false });
        return;
      }
      case 'plantillas': {
        const c = await chatbotConfig(db);
        if (!c) { res.status(200).json({ conectado: false, plantillas: [] }); return; }
        const [meta, mapas] = await Promise.all([
          chatbot.llamar(c, 'GET', 'whatsapp/message-templates'),
          db.get('plantillas_whatsapp?select=nombre,idioma,variables')
        ]);
        const plantillas = (meta.data || []).map(t => {
          const m = mapas.find(x => x.nombre === t.name && x.idioma === t.language);
          const n = Number(t.parameters_count) || new Set((String(t.body || '').match(/\{\{\d+\}\}/g) || [])).size;
          return { nombre: t.name, idioma: t.language, estado: t.status, categoria: t.category, texto: t.body || '', parametros: n, variables: m ? m.variables : null, motivoRechazo: t.rejected_reason || null };
        });
        res.status(200).json({ conectado: true, plantillas, variablesDisponibles: Object.keys(chatbot.VARIABLES) });
        return;
      }
      case 'crear_plantilla': {
        const c = await chatbotConfig(db);
        if (!c) throw new Error('chatbotproia no está conectado.');
        const nombre = chatbot.nombrePlantilla(body.nombre);
        const categoria = body.categoria === 'UTILITY' ? 'UTILITY' : 'MARKETING';
        const { cuerpo, variables, ejemplos } = chatbot.convertirTexto(body.texto);
        const creada = await chatbot.llamar(c, 'POST', 'whatsapp/message-templates', { name: nombre, language: 'es_MX', category: categoria, bodyText: cuerpo, bodyExample: ejemplos });
        await db.post('plantillas_whatsapp?on_conflict=nombre,idioma', [{ nombre, idioma: 'es_MX', variables, texto_original: String(body.texto).slice(0, 1024), creado_por: enviadoPor }], 'resolution=merge-duplicates,return=minimal');
        res.status(200).json({ plantilla: { nombre, idioma: 'es_MX', estado: creada.status || 'PENDING', categoria, texto: cuerpo, parametros: variables.length, variables } });
        return;
      }
      case 'mapear_plantilla': {
        const variables = (Array.isArray(body.variables) ? body.variables : []).map(String);
        if (!body.nombre || variables.some(v => !(v in chatbot.VARIABLES))) throw new Error('Variables inválidas.');
        await db.post('plantillas_whatsapp?on_conflict=nombre,idioma', [{ nombre: String(body.nombre), idioma: String(body.idioma || 'es_MX'), variables, creado_por: enviadoPor }], 'resolution=merge-duplicates,return=minimal');
        res.status(200).json({ ok: true });
        return;
      }
      case 'historial':
        res.status(200).json({ historial: await db.get('retransmisiones?select=*&order=created_at.desc&limit=300') });
        return;
      default:
        res.status(400).json({ error: 'Acción inválida' });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

module.exports.telefonoWhatsApp = telefonoWhatsApp;
module.exports.ligaRecuperar = ligaRecuperar;
module.exports.rellenar = rellenar;
