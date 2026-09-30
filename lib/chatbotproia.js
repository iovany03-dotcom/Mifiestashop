// Cliente del API pública de chatbotproia (panel.chatbotproia.com/api-docs) — usado para
// mandar WhatsApp real (plantillas aprobadas por Meta) desde "Retransmisiones", a diferencia
// del wa.me manual (ver telefonoWhatsApp en api/retransmisiones.js) que solo prepara el texto
// para que el staff lo abra y lo mande a mano. Requiere CHATBOTPROIA_TOKEN en Vercel: el
// X-ACCESS-TOKEN del bot conectado al WhatsApp Business de la tienda (Ajustes > Integraciones
// dentro de chatbotproia).
const CHATBOTPROIA_BASE = 'https://panel.chatbotproia.com/api';

function chatbotproiaConfigured() {
  return !!process.env.CHATBOTPROIA_TOKEN;
}

async function cpFetch(path, opts) {
  const token = process.env.CHATBOTPROIA_TOKEN;
  if (!token) throw new Error('Falta CHATBOTPROIA_TOKEN en Vercel.');
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
async function cpListarPlantillas() {
  const data = await cpFetch('/whatsapp/message-templates');
  return (Array.isArray(data.data) ? data.data : []).filter(t => t.status === 'APPROVED');
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

module.exports = { chatbotproiaConfigured, cpListarPlantillas, cpBuscarOCrearContacto, cpEnviarPlantilla };
