// Optimización SEO de productos con IA y guardado: la usan el módulo SEO (api/seo.js, botón
// "Optimizar con IA" y la cola de aprobación) y la tarea automática que llena la cola
// (api/cron-seo-ia.js).
const { sb } = require('./seo-datos.js');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const ESQUEMA_SEO = {
  type: 'object', additionalProperties: false, required: ['productos'],
  properties: {
    productos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'meta_title', 'meta_description', 'descripcion_html', 'palabra_clave'],
        properties: {
          id: { type: 'integer' },
          palabra_clave: { type: 'string', description: 'Búsqueda principal en Google para este producto.' },
          meta_title: { type: 'string', description: 'Máximo 55 caracteres, sin "| Mi Fiestashop" (se agrega solo).' },
          meta_description: { type: 'string', description: '120 a 155 caracteres.' },
          descripcion_html: { type: 'string', description: 'Descripción de 120 a 220 palabras en HTML simple (<p>, <ul><li>, <strong>).' }
        }
      }
    }
  }
};

async function optimizarIA({ ids }) {
  const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger).slice(0, 3);
  if (!lista.length) throw new HttpError(400, 'Elige de 1 a 3 productos.');
  const filas = await sb(`/rest/v1/catalogo_productos?select=id,name,sku,price,price_mayoreo,price_mayoreo_desde_unidades,category_label,description,description_short,meta_title,meta_description&id=in.(${lista.join(',')})`);
  const { generarJson } = require('../lib/recepcion-ia.js');
  const texto = filas.map(p => JSON.stringify({
    id: p.id, nombre: p.name, categoria: p.category_label, precio: p.price,
    mayoreo: p.price_mayoreo ? `${p.price_mayoreo} desde ${p.price_mayoreo_desde_unidades} pzas` : null,
    descripcion_actual: String(p.description || p.description_short || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    meta_title_actual: p.meta_title, meta_description_actual: p.meta_description
  })).join('\n');
  const d = await generarJson({
    nombre: 'seo_productos', esquema: ESQUEMA_SEO, maxTokens: 12000, esfuerzo: 'low',
    sistema: `Eres especialista en SEO de comercio electrónico en México para Mi Fiestashop (artículos para fiesta, batucada, bodas, XV años, cumpleaños; venta por menudeo y mayoreo, envíos a todo México, tiendas en CDMX, Puebla y Querétaro).
Para cada producto escribe en español de México:
- palabra_clave: la búsqueda que haría un cliente en Google (ej. "collar hawaiano mayoreo").
- meta_title: máximo 55 caracteres, empieza con el nombre del producto y puede sumar un dato real (material, uso o presentación); sin el nombre de la tienda. NUNCA repitas el nombre del producto ni palabras dentro del título, ni lo termines con "mayoreo" o con una segunda frase que lo repita (mal: "Globo gato - globo gato mayoreo"; bien: "Globo gato metálico para cumpleaños").
- meta_description: 120 a 155 caracteres, beneficio + uso en fiestas + "mayoreo" o "envío a todo México", que invite al clic.
- descripcion_html: 120 a 220 palabras, HTML simple (<p>, <ul><li>, <strong>), útil para el cliente: qué es, para qué fiestas sirve, ideas de uso, y una línea sobre mayoreo si aplica.
NUNCA inventes medidas, materiales, colores, cantidades por paquete ni datos que no estén en la información dada; si no se sabe, no lo menciones. Sin emojis. No repitas la palabra clave de forma forzada.`,
    contenido: [{ type: 'text', text: `Productos (uno por línea, JSON):\n${texto}` }]
  });
  const porId = new Map(filas.map(p => [p.id, p]));
  return {
    propuestas: (d.productos || []).filter(x => porId.has(Number(x.id))).map(x => ({
      id: Number(x.id), nombre: porId.get(Number(x.id)).name, palabra_clave: String(x.palabra_clave || '').slice(0, 80),
      meta_title: String(x.meta_title || '').slice(0, 70), meta_description: String(x.meta_description || '').slice(0, 170),
      descripcion_html: String(x.descripcion_html || '').slice(0, 6000)
    }))
  };
}

function limpiarHtml(h) {
  // Solo etiquetas simples de texto; quita scripts, estilos y atributos.
  return String(h || '')
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<(\/?)(p|ul|ol|li|strong|b|em|i|br|h2|h3)\b[^>]*>/gi, '<$1$2>')
    .replace(/<(?!\/?(p|ul|ol|li|strong|b|em|i|br|h2|h3)>)[^>]*>/gi, '')
    .trim().slice(0, 20000);
}

async function guardarProducto({ id, meta_title, meta_description, descripcion }, s = { nombre: 'Sistema' }) {
  const pid = Number(id);
  if (!Number.isSafeInteger(pid)) throw new HttpError(400, 'Producto inválido.');
  const cambio = { updated_at: new Date().toISOString() };
  if (meta_title !== undefined) { const t = String(meta_title).replace(/\s*\|\s*Mi Fiestashop\s*$/i, '').trim().slice(0, 70); cambio.meta_title = t || null; }
  if (meta_description !== undefined) cambio.meta_description = String(meta_description).replace(/\s+/g, ' ').trim().slice(0, 170) || null;
  if (descripcion !== undefined && String(descripcion).trim()) cambio.description = limpiarHtml(descripcion);
  const [p] = await sb(`/rest/v1/catalogo_productos?id=eq.${pid}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(cambio) });
  if (!p) throw new HttpError(404, 'No existe ese producto.');
  // La tienda muestra la descripción de productos_migrados cuando existe: se actualiza también.
  if (cambio.description) await sb(`/rest/v1/productos_migrados?id=eq.${pid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ description: cambio.description }) }).catch(() => {});
  return { guardado: true, id: pid, por: s.nombre };
}

module.exports = { optimizarIA, guardarProducto, limpiarHtml, HttpError };
