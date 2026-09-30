// Conexión con la API pública de chatbotproia (el bot de WhatsApp de Mi
// Fiestashop) para "Retransmisiones": mandar WhatsApp de verdad (con
// plantillas aprobadas por Meta) y crear esas plantillas. La URL y la llave
// (X-ACCESS-TOKEN, de chatbotproia → Ajustes → Integraciones/API de la cuenta
// Mi Fiestashop) se guardan en la tabla integraciones (clave 'chatbotproia'),
// que solo lee el servidor.
const URL_DEFAULT = 'https://panel.chatbotproia.com/api';

// Variables de Retransmisiones que pueden ir en una plantilla de WhatsApp,
// con el ejemplo que se le manda a Meta al crearla (lo exige para revisarla).
const VARIABLES = {
  nombre: 'Ana',
  cupon: 'VUELVE-K7M2QP',
  descuento: '10%',
  vence: 'jueves 2 de octubre, 8:00 p.m.',
  liga: 'https://www.mifiestashop.com/?carrito=83591x1&cupon=VUELVE-K7M2QP',
  total: '$1,250.00'
};

function limpiarUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return URL_DEFAULT;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(u)) throw new Error('La URL de chatbotproia debe empezar con https:// (ej. https://panel.chatbotproia.com/api).');
  if (!/\/api$/.test(u)) u += '/api';
  return u;
}

async function llamar(config, metodo, ruta, body) {
  if (!config || !config.token) throw new Error('chatbotproia no está conectado. Pon la llave en Retransmisiones → Plantillas WhatsApp.');
  let r;
  try {
    r = await fetch(`${config.url}/${ruta}`, {
      method: metodo,
      headers: { 'X-ACCESS-TOKEN': config.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error(`No se pudo conectar con chatbotproia (${e.message}).`);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(r.status === 401 ? 'La llave de chatbotproia no es válida.' : (data.error || `chatbotproia respondió HTTP ${r.status}`));
    err.status = r.status;
    err.requiresTemplate = !!data.requiresTemplate;
    throw err;
  }
  return data;
}

// Texto con {nombre} {cupon}… -> texto de Meta con {{1}} {{2}}… en el orden
// en que aparecen, la lista de variables y los ejemplos.
function convertirTexto(texto) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Escribe el texto de la plantilla.');
  if (t.length > 1024) throw new Error('El texto de la plantilla puede tener máximo 1024 caracteres.');
  const desconocidas = [...t.matchAll(/\{([a-z_]+)\}/gi)].map(m => m[1]).filter(v => !(v.toLowerCase() in VARIABLES));
  if (desconocidas.length) throw new Error(`Variable no reconocida: {${desconocidas[0]}}. Usa {nombre}, {cupon}, {descuento}, {vence}, {liga} o {total}.`);
  if (/\{\{\d+\}\}/.test(t)) throw new Error('Escribe las variables con su nombre ({nombre}, {cupon}…), no como {{1}}.');
  const variables = [];
  const cuerpo = t.replace(/\{([a-z_]+)\}/gi, (_, v) => {
    const k = v.toLowerCase();
    if (!variables.includes(k)) variables.push(k);
    return `{{${variables.indexOf(k) + 1}}}`;
  });
  // Regla de Meta: el texto no puede empezar ni terminar con una variable.
  if (/^\{\{\d+\}\}/.test(cuerpo) || /\{\{\d+\}\}[\s.!?¡¿]*$/.test(cuerpo)) {
    throw new Error('Meta no acepta plantillas que empiezan o terminan con una variable: agrega texto antes o después (ej. "…aquí: {liga} ¡Te esperamos!").');
  }
  return { cuerpo, variables, ejemplos: variables.map(v => VARIABLES[v]) };
}

function nombrePlantilla(nombre) {
  const n = String(nombre || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) throw new Error('Ponle nombre a la plantilla.');
  return n.slice(0, 60);
}

module.exports = { URL_DEFAULT, VARIABLES, limpiarUrl, llamar, convertirTexto, nombrePlantilla };
