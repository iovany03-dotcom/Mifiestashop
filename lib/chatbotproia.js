// Cliente del API pública de chatbotproia (panel.chatbotproia.com/api-docs) — usado para
// mandar WhatsApp real (plantillas aprobadas por Meta) desde "Retransmisiones", a diferencia
// del wa.me manual (ver telefonoWhatsApp en api/retransmisiones.js) que solo prepara el texto
// para que el staff lo abra y lo mande a mano.
//
// El token (X-ACCESS-TOKEN del bot conectado al WhatsApp Business de la tienda, generado en
// chatbotproia -> Ajustes -> Integraciones) se guarda en Supabase (tabla
// ajustes_chatbotproia, sin ninguna policy de RLS: solo se toca con la llave de servicio,
// nunca con la llave anon desde el navegador) para que el admin lo pueda configurar/rotar
// desde "Retransmisiones" sin depender de un despliegue. CHATBOTPROIA_TOKEN en Vercel queda
// como respaldo si todavía no se ha guardado ninguno ahí.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const CHATBOTPROIA_BASE = 'https://panel.chatbotproia.com/api';

function sbHeaders() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en Vercel.');
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

async function obtenerToken() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ajustes_chatbotproia?select=token&order=id.desc&limit=1`, { headers: sbHeaders() });
    if (r.ok) {
      const rows = await r.json();
      if (rows[0] && rows[0].token) return rows[0].token;
    }
  } catch (e) { /* cae al respaldo de abajo */ }
  return process.env.CHATBOTPROIA_TOKEN || null;
}

async function guardarToken(token) {
  const limpio = String(token || '').trim();
  if (!limpio) throw new Error('El token no puede quedar vacío.');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ajustes_chatbotproia`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([{ token: limpio, updated_at: new Date().toISOString() }])
  });
  if (!r.ok) throw new Error(`No se pudo guardar el token (HTTP ${r.status}).`);
}

async function chatbotproiaConfigured() {
  return !!(await obtenerToken());
}

async function cpFetch(path, opts) {
  const token = await obtenerToken();
  if (!token) throw new Error('Todavía no has configurado el token de chatbotproia.');
  const r = await fetch(`${CHATBOTPROIA_BASE}${path}`, {
    ...opts,
    headers: { 'X-ACCESS-TOKEN': token, 'Content-Type': 'application/json', ...(opts && opts.headers) }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `chatbotproia ${path} -> HTTP ${r.status}`);
  return data;
}

// Plantillas aprobadas por Meta para el bot conectado, con el texto real del cuerpo y cuántos
// parámetros {{n}} necesita (ver whatsapp/message-templates en chatbotproia).
// El API puede devolver la plantilla "plana" (body_text / param_count) o en el formato de Meta
// (components: [{ type: 'BODY', text, example }]); se normaliza a body_text + param_count para que
// el panel sepa cuántas variables {{n}} hay que mandar — mandar de menos/más hace que Meta
// rechace el envío con (#132000) "Number of parameters does not match".
function normalizarPlantilla(t) {
  const comps = Array.isArray(t.components) ? t.components : (t.template && Array.isArray(t.template.components) ? t.template.components : []);
  const body = comps.find(c => String(c && c.type).toUpperCase() === 'BODY') || null;
  const crudo = t.body_text != null ? t.body_text : (body && body.text != null ? body.text : (t.body != null ? t.body : (t.text != null ? t.text : t.content)));
  const texto = typeof crudo === 'string' ? crudo : (crudo && typeof crudo.text === 'string' ? crudo.text : '');
  let n = 0;
  for (const m of texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) n = Math.max(n, parseInt(m[1], 10));
  if (!n && body && body.example && Array.isArray(body.example.body_text) && Array.isArray(body.example.body_text[0])) n = body.example.body_text[0].length;
  const dado = [t.param_count, t.params_count, t.parameter_count, t.variables_count].map(Number).find(v => Number.isFinite(v));
  return { ...t, body_text: texto, param_count: Math.max(n, dado || 0) };
}

async function cpListarPlantillas() {
  const data = await cpFetch('/whatsapp/message-templates');
  return (Array.isArray(data.data) ? data.data : []).filter(t => t.status === 'APPROVED').map(normalizarPlantilla);
}

// Encuentra al cliente por teléfono en el CRM de chatbotproia o lo da de alta si nunca le ha
// escrito al bot — sin esto, send/whatsapp de abajo no tiene a quién mandarle nada (ver PR
// iovany03-dotcom/chatbotproia#217, que corrigió que este alta antes no creaba un contacto
// real). Regresa el id (UUID) del contacto.
async function cpBuscarOCrearContacto(telefonoE164, nombre) {
  const found = await cpFetch(`/contacts/find_by_custom_field?field_id=phone&value=${encodeURIComponent(telefonoE164)}`);
  const existing = Array.isArray(found.data) && found.data[0];
  if (existing) return existing.id;
  const created = await cpFetch('/contacts', {
    method: 'POST',
    body: JSON.stringify({ phone: telefonoE164, first_name: nombre || 'Cliente' })
  });
  return created.id;
}

// Manda la plantilla aprobada al contacto. `parametros` va en el mismo orden que los {{n}} del
// cuerpo aprobado en Meta.
async function cpEnviarPlantilla(contactId, { name, language, parametros }) {
  return cpFetch(`/contacts/${contactId}/send/whatsapp`, {
    method: 'POST',
    body: JSON.stringify({ template: { name, language, parameters: parametros || [] } })
  });
}

module.exports = {
  chatbotproiaConfigured, guardarToken, cpListarPlantillas, normalizarPlantilla, cpBuscarOCrearContacto, cpEnviarPlantilla
};
