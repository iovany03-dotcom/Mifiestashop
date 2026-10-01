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
//                  tipo, valor, minimo, horas, codigo, prefijo },
//                  plantillaWa?: { name, language, mapping: ['nombre'|'cupon'|'descuento'|'vence'|'liga', ...] } }
//       -> { resultados: [{ referencia, ok, codigo, whatsapp, error }] }
//       El mensaje admite {nombre}, {cupon}, {descuento}, {vence} y {liga}.
//       WhatsApp: si se manda "plantillaWa" (una plantilla ya aprobada por Meta, ver
//       'plantillas_whatsapp' abajo), se manda real y directo vía chatbotproia
//       (lib/chatbotproia.js); sin ella, se regresa la liga wa.me con el texto listo para que
//       el staff la abra y la mande a mano (no hay otra forma de que Meta lo entregue solo).
//   'plantillas_whatsapp' -> { plantillas: [{ name, language, status, category, body_text,
//                              param_count }] } — las aprobadas en Meta para el bot de
//                              chatbotproia conectado (ver 'chatbotproia_estado'/
//                              'chatbotproia_guardar_token').
//   'chatbotproia_estado' -> { configurado: bool } — nunca regresa el token en sí.
//   'chatbotproia_guardar_token' { token } -> { ok: true } | { ok: false, error } — guarda el
//       token y de una vez prueba la conexión real contra chatbotproia (se guarda aunque la
//       prueba falle, para no perder lo que se tecleó).
//   'cupones'    -> { cupones: [...] }
//   'crear_cupon' { codigo?, prefijo?, tipo, valor, minimo, inicia, vence, usos_max, email, descripcion }
//   'cupon_activo' { codigo, activo }
//   'historial'  -> { historial: [...] }
//   'auto_config_leer' -> { config: {...} | null } — ver tabla ajustes_retransmision_auto.
//   'auto_config_guardar' { activo, horas_espera, dias_buscar, plantilla_nombre, plantilla_idioma,
//                           plantilla_mapping, cupon_tipo: null|'porcentaje'|'monto'|'existente',
//                           cupon_codigo (solo si cupon_tipo es 'existente'), cupon_valor,
//                           cupon_minimo, cupon_vigencia_horas, cupon_prefijo } -> { ok: true }
//       Config leída y aplicada por api/cron-retransmision-auto.js (corre cada hora, ver
//       vercel.json): a quien pasó "horas_espera" desde que abandonó (dentro de los últimos
//       "dias_buscar" días) y nunca se le mandó WhatsApp antes (manual o automático), se le
//       manda la plantilla con el cupón configurado — mismo "enviar()" de abajo, disparado por
//       cron en vez de por un clic del staff.
const { layout, escapeHtml, sendHtml, smtpConfigured } = require('../lib/correo.js');
const { CODIGO_RE, normalizarCodigo, generarCodigo, etiquetaCupon } = require('../lib/cupones.js');
const { cpListarPlantillas, cpBuscarOCrearContacto, cpEnviarPlantilla, chatbotproiaConfigured, guardarToken } = require('../lib/chatbotproia.js');

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
    const rows = await db.get(`pedidos_online?folio=eq.${encodeURIComponent(ref)}&select=folio,customer_name,customer_email,customer_phone,items&limit=1`);
    const p = rows[0];
    if (!p) return null;
    return { tipo: 'pedido', referencia: p.folio, nombre: p.customer_name || '', email: p.customer_email || '', telefono: p.customer_phone || '', items: itemsDe(p.items) };
  }
  const m = ref.match(/^CRW-(\d+)$/);
  if (d.tipo === 'carrito' && m) {
    const rows = await db.get(`carritos_web?id=eq.${m[1]}&select=id,customer_name,customer_email,customer_phone,items&limit=1`);
    const c = rows[0];
    if (!c) return null;
    return { tipo: 'carrito', referencia: ref, nombre: c.customer_name || '', email: c.customer_email || '', telefono: c.customer_phone || '', items: itemsDe(c.items) };
  }
  return null;
}

async function enviar(db, body, enviadoPor) {
  const canal = body.canal === 'whatsapp' ? 'whatsapp' : 'email';
  const destinos = (Array.isArray(body.destinatarios) ? body.destinatarios : []).slice(0, MAX_ENVIO);
  if (!destinos.length) throw new Error('Selecciona al menos un cliente.');
  const mensaje = String(body.mensaje || '').slice(0, 3000);
  const asunto = String(body.asunto || '').slice(0, 150) || '¡Tu carrito te está esperando!';
  const plantillaWa = body.plantillaWa && body.plantillaWa.name && body.plantillaWa.language ? body.plantillaWa : null;
  // Con una plantilla real de Meta, el mensaje que de verdad se manda es la propia plantilla
  // aprobada (ver más abajo) — el "mensaje" libre solo se usa para el registro en
  // "retransmisiones" (historial), así que aquí no es obligatorio.
  if (!mensaje.trim() && !plantillaWa) throw new Error('Escribe el mensaje.');
  if (canal === 'email' && !smtpConfigured()) throw new Error('El correo (SMTP) no está configurado en Vercel.');

  const cfg = body.cupon || { modo: 'ninguno' };
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
      const wa = canal === 'whatsapp' ? telefonoWhatsApp(dest.telefono) : null;
      if (canal === 'whatsapp' && !wa) throw new Error('No tiene un teléfono válido.');

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
        email: dest.email || null, telefono: dest.telefono || null, asunto: canal === 'email' ? rellenar(asunto, { nombre }) : null,
        mensaje: texto, cupon_codigo: cupon ? cupon.codigo : null, enviado_por: enviadoPor
      };
      if (canal === 'email') {
        try {
          await sendHtml(dest.email, log.asunto, correoHtml({ mensaje: texto, items: dest.items, cupon: tc, liga }));
          log.estado = 'enviado';
        } catch (e) {
          log.estado = 'error'; log.error = String(e.message).slice(0, 300);
        }
      } else {
        // El texto ya lleva la liga si el mensaje usa {liga}; si no, se agrega.
        const final = texto.includes(liga) ? texto : `${texto}\n\n${liga}`;
        log.mensaje = final;
        // Con una plantilla real de Meta elegida (ver plantillas_whatsapp abajo) se manda
        // directo vía chatbotproia; sin ella, se regresa el wa.me de siempre para que el staff
        // lo abra y lo mande a mano (no hay otra forma de que Meta lo entregue solo).
        if (plantillaWa) {
          try {
            // Meta rechaza con (#131008) "Required parameter is missing" cualquier variable
            // {{n}} mandada como cadena vacía — pasa, por ejemplo, con un cupón sin fecha de
            // vencimiento (fechaMx(null) -> '') o un pedido/carrito sin nombre de cliente
            // guardado. Nunca se manda "" como parámetro; se rellena con algo real.
            const campos = {
              nombre: nombre || 'Cliente',
              cupon: tc ? tc.codigo : '',
              descuento: tc ? tc.descuento : '',
              vence: (tc && tc.vence) || 'sin fecha límite',
              liga
            };
            const parametros = (Array.isArray(plantillaWa.mapping) ? plantillaWa.mapping : []).map(k => campos[k] || '-');
            const contactId = await cpBuscarOCrearContacto(wa, dest.nombre);
            await cpEnviarPlantilla(contactId, { name: plantillaWa.name, language: plantillaWa.language, parametros });
            log.estado = 'enviado';
          } catch (e) {
            log.estado = 'error';
            log.error = String(e.message).slice(0, 300);
            if (/132000/.test(log.error)) log.error = 'La plantilla espera otro número de variables ({{n}}) del que se mandó: revisa cuántas tiene en Meta y ajústalas en "Variable" arriba. ' + log.error.slice(0, 150);
            if (/131008/.test(log.error)) log.error = 'A la plantilla le falta una variable (Meta no acepta una vacía): revisa que cada "Variable {{n}}" esté mapeada a un dato real (si mapeaste "Código de cupón" o "Descuento", confirma que sí elegiste un cupón). ' + log.error.slice(0, 150);
          }
        } else {
          log.estado = 'preparado';
          r.whatsapp = `https://wa.me/${wa}?text=${encodeURIComponent(final)}`;
        }
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
      case 'plantillas_whatsapp':
        res.status(200).json({ plantillas: await cpListarPlantillas() });
        return;
      case 'chatbotproia_estado':
        res.status(200).json({ configurado: await chatbotproiaConfigured() });
        return;
      case 'chatbotproia_guardar_token': {
        await guardarToken(body.token);
        try {
          const plantillas = await cpListarPlantillas();
          res.status(200).json({ ok: true, plantillas });
        } catch (e) {
          // El token ya quedó guardado (es lo que se pidió); se avisa del error de conexión
          // aparte para no hacer parecer que no se guardó nada.
          res.status(200).json({ ok: false, error: e.message });
        }
        return;
      }
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
      case 'historial':
        res.status(200).json({ historial: await db.get('retransmisiones?select=*&order=created_at.desc&limit=300') });
        return;
      case 'auto_config_leer': {
        const rows = await db.get('ajustes_retransmision_auto?select=*&order=id.desc&limit=1');
        res.status(200).json({ config: rows[0] || null });
        return;
      }
      case 'auto_config_guardar': {
        const row = {
          activo: !!body.activo,
          horas_espera: Math.max(1, parseInt(body.horas_espera, 10) || 24),
          dias_buscar: Math.max(1, Math.min(90, parseInt(body.dias_buscar, 10) || 14)),
          plantilla_nombre: body.plantilla_nombre ? String(body.plantilla_nombre).slice(0, 200) : null,
          plantilla_idioma: body.plantilla_idioma ? String(body.plantilla_idioma).slice(0, 20) : null,
          plantilla_mapping: Array.isArray(body.plantilla_mapping) ? body.plantilla_mapping : null,
          cupon_tipo: ['monto', 'porcentaje', 'existente'].includes(body.cupon_tipo) ? body.cupon_tipo : null,
          cupon_codigo: body.cupon_tipo === 'existente' ? normalizarCodigo(body.cupon_codigo) : null,
          cupon_valor: Number(body.cupon_valor) || 0,
          cupon_minimo: Math.max(0, Number(body.cupon_minimo) || 0),
          cupon_vigencia_horas: Math.max(1, parseInt(body.cupon_vigencia_horas, 10) || 48),
          cupon_prefijo: String(body.cupon_prefijo || 'AUTO').trim().toUpperCase().slice(0, 12) || 'AUTO',
          updated_at: new Date().toISOString()
        };
        if (row.activo && (!row.plantilla_nombre || !row.plantilla_idioma)) {
          throw new Error('Elige una plantilla aprobada antes de activar el envío automático.');
        }
        if (row.cupon_tipo === 'existente' && !row.cupon_codigo) {
          throw new Error('Elige un cupón ya existente, o crea uno primero.');
        }
        await db.post('ajustes_retransmision_auto', [row], 'return=minimal');
        res.status(200).json({ ok: true });
        return;
      }
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
module.exports.audiencia = audiencia;
module.exports.enviar = enviar;
module.exports.sb = sb;
