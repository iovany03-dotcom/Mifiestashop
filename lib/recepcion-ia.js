// Lectura de notas de compra y fotos de producto con IA, para la Recepción Inteligente
// de Mercancía (api/recepcion.js).
//
// La IA solo devuelve datos estructurados (JSON con esquema fijo). Nada de lo que regresa toca
// el inventario: las cantidades, diferencias y movimientos los calculan y validan las funciones
// de la base de datos (docs/supabase-recepcion.sql).
//
// Proveedor de IA según la llave que haya en Vercel:
//   OPENAI_API_KEY    -> ChatGPT (OpenAI). Modelo en OPENAI_MODEL (por defecto gpt-5).
//   ANTHROPIC_API_KEY -> Claude. Se usa solo si no hay llave de OpenAI.

const Anthropic = require('@anthropic-ai/sdk');

const MODELO = 'claude-opus-5-5';

function proveedorIA() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('Falta la llave de IA en Vercel: agrega OPENAI_API_KEY (ChatGPT) o ANTHROPIC_API_KEY (Claude).');
}

let cliente = null;
function claude() {
  if (!cliente) cliente = new (Anthropic.default || Anthropic)();
  return cliente;
}

// ChatGPT por la API de Chat Completions con salida JSON estricta (mismo esquema que Claude).
// contenido: bloques en formato Claude ({type:'text'|'image'|'document'}), se traducen aquí.
async function llamarOpenAI({ sistema, contenido, esquema, nombre, maxTokens }) {
  const partes = contenido.map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}`, detail: 'high' } };
    if (b.type === 'document') return { type: 'file', file: { filename: 'nota.pdf', file_data: `data:application/pdf;base64,${b.source.data}` } };
    throw new Error('Bloque no soportado');
  });
  const modelo = process.env.OPENAI_MODEL || 'gpt-5';
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelo,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: sistema }, { role: 'user', content: partes }],
      response_format: { type: 'json_schema', json_schema: { name: nombre, strict: true, schema: esquema } }
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d.error && d.error.message) || `HTTP ${r.status}`;
    if (r.status === 401) throw new Error('La llave de OpenAI no es válida (revisa OPENAI_API_KEY en Vercel).');
    if (r.status === 429) throw new Error('OpenAI rechazó la petición por límite o falta de saldo: ' + msg);
    throw new Error('OpenAI: ' + msg);
  }
  const ch = d.choices && d.choices[0];
  if (!ch) throw new Error('OpenAI no devolvió respuesta.');
  if (ch.message && ch.message.refusal) throw new Error('La IA no procesó el documento.');
  if (ch.finish_reason === 'length') throw new Error('La nota es demasiado larga para leerla de una vez; súbela en partes.');
  try { return { datos: JSON.parse(ch.message.content), modelo: d.model || modelo }; }
  catch (e) { throw new Error('La IA devolvió una respuesta que no se pudo interpretar.'); }
}

const numONull = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const textoONull = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const ESQUEMA_NOTA = {
  type: 'object',
  additionalProperties: false,
  required: ['folio', 'fecha', 'proveedor', 'subtotal', 'total', 'lineas', 'advertencias'],
  properties: {
    folio: textoONull,
    fecha: { ...textoONull, description: 'Fecha de la nota en formato AAAA-MM-DD, o null.' },
    proveedor: { ...textoONull, description: 'Nombre del proveedor como aparece en la nota, o null.' },
    subtotal: numONull,
    total: numONull,
    lineas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['codigo', 'descripcion', 'cantidad', 'precio_unitario', 'importe', 'legible', 'nota'],
        properties: {
          codigo: { ...textoONull, description: 'Código del proveedor EXACTAMENTE como está escrito (letras, números, guiones, ceros iniciales).' },
          descripcion: textoONull,
          cantidad: numONull,
          precio_unitario: numONull,
          importe: numONull,
          legible: { type: 'boolean', description: 'false si algún dato de la línea no se pudo leer con seguridad.' },
          nota: { ...textoONull, description: 'Qué no se pudo leer o qué parece inconsistente en la línea.' }
        }
      }
    },
    advertencias: { type: 'array', items: { type: 'string' } }
  }
};

const INSTRUCCIONES_NOTA = `Eres el lector de notas de compra de Mi Fiesta Shop, una tienda de artículos de fiesta en México.
Recibes las fotos o el PDF de UNA nota de un proveedor (puede tener varias páginas, en orden). Extrae cada renglón de producto.

Reglas:
- Copia el código del proveedor carácter por carácter, tal como aparece: conserva ceros a la izquierda, guiones, letras y espacios internos. No lo corrijas ni lo completes.
- Las notas suelen traer solo código, cantidad, precio e importe, sin nombre del producto. Si hay descripción, cópiala; si no, deja null.
- Cantidad, precio unitario e importe son números sin signo de pesos ni comas de miles. Si un dato no se lee con seguridad, ponlo en null, marca legible=false y explica en "nota". Nunca inventes un valor.
- Las notas manuscritas son comunes: lee con cuidado y marca como no legible lo que sea dudoso.
- No incluyas renglones que no sean productos (subtotales, IVA, descuentos globales, firmas); el subtotal y total van en sus campos.
- Si cantidad × precio no coincide con el importe, o la suma de importes no coincide con el total, agrégalo en "advertencias".
- Si una misma página aparece dos veces, no dupliques renglones.`;

// archivos: [{ media_type: 'image/jpeg'|'image/png'|'image/webp'|'application/pdf', data: base64 }]
async function leerNota(archivos, { proveedor } = {}) {
  const contenido = [];
  archivos.forEach((a, i) => {
    contenido.push({ type: 'text', text: `Página/archivo ${i + 1} de ${archivos.length}:` });
    if (a.media_type === 'application/pdf') {
      contenido.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    } else {
      contenido.push({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } });
    }
  });
  contenido.push({ type: 'text', text: `Proveedor seleccionado por el empleado: ${proveedor || 'no indicado'}. Extrae la nota.` });

  if (proveedorIA() === 'openai') {
    const { datos, modelo } = await llamarOpenAI({ sistema: INSTRUCCIONES_NOTA, contenido, esquema: ESQUEMA_NOTA, nombre: 'nota_compra', maxTokens: 32000 });
    return { ...datos, modelo };
  }
  const stream = claude().messages.stream({
    model: MODELO,
    max_tokens: 32000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: ESQUEMA_NOTA } },
    system: INSTRUCCIONES_NOTA,
    messages: [{ role: 'user', content: contenido }]
  });
  const resp = await stream.finalMessage();
  return { ...interpretar(resp), modelo: resp.model };
}

const ESQUEMA_FOTO = {
  type: 'object',
  additionalProperties: false,
  required: ['descripcion', 'busquedas', 'candidatos'],
  properties: {
    descripcion: { type: 'string', description: 'Qué producto se ve en la foto, en pocas palabras.' },
    busquedas: { type: 'array', items: { type: 'string' }, description: 'De 1 a 5 búsquedas cortas (2-3 palabras) para encontrarlo en el catálogo.' },
    candidatos: {
      type: 'array',
      description: 'Ids de los productos del catálogo enviado que se parecen, del más al menos parecido. Vacío si ninguno se parece.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'motivo'],
        properties: { id: { type: 'integer' }, motivo: { type: 'string' } }
      }
    }
  }
};

// Paso 1: describir la foto y proponer búsquedas. Paso 2 (con `catalogo`): elegir entre esos
// productos los que se parecen. La IA solo sugiere; el empleado elige y confirma.
async function sugerirPorFoto(foto, catalogo = []) {
  const contenido = [{ type: 'image', source: { type: 'base64', media_type: foto.media_type, data: foto.data } }];
  if (catalogo.length) {
    contenido.push({
      type: 'text',
      text: 'Productos del catálogo que podrían ser (id | nombre | categoría):\n' +
        catalogo.map(p => `${p.id} | ${p.name} | ${p.categoria || ''}`).join('\n') +
        '\n\nElige los que corresponden al producto de la foto (máximo 8). Si ninguno, deja candidatos vacío.'
    });
  } else {
    contenido.push({ type: 'text', text: 'Describe el producto y propone búsquedas para el catálogo. Deja candidatos vacío.' });
  }
  const SISTEMA_FOTO = 'Ayudas a identificar productos de una tienda de artículos de fiesta (globos, piñatas, disfraces, decoración, desechables) a partir de una foto. Solo sugieres; nunca confirmas.';
  if (proveedorIA() === 'openai') {
    return (await llamarOpenAI({ sistema: SISTEMA_FOTO, contenido, esquema: ESQUEMA_FOTO, nombre: 'producto_foto', maxTokens: 8000 })).datos;
  }
  const stream = claude().messages.stream({
    model: MODELO,
    max_tokens: 8000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA_FOTO } },
    system: SISTEMA_FOTO,
    messages: [{ role: 'user', content: contenido }]
  });
  return interpretar(await stream.finalMessage());
}

function interpretar(resp) {
  if (resp.stop_reason === 'refusal') throw new Error('La IA no procesó el documento.');
  if (resp.stop_reason === 'max_tokens') throw new Error('La nota es demasiado larga para leerla de una vez; súbela en partes.');
  const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(texto); } catch (e) { throw new Error('La IA devolvió una respuesta que no se pudo interpretar.'); }
}

// Limpieza de lo que regresa la IA antes de guardarlo: tipos correctos y códigos tal cual
// (solo se quitan espacios en los extremos).
function normalizarLectura(d) {
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10000) / 10000);
  const txt = (v, n) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha || '')) ? d.fecha : null;
  const lineas = (Array.isArray(d.lineas) ? d.lineas : []).slice(0, 500).map(l => {
    const codigo = txt(l.codigo, 80);
    const cantidad = num(l.cantidad);
    const precio = num(l.precio_unitario);
    const importe = num(l.importe);
    const motivos = [];
    if (!l.legible) motivos.push(txt(l.nota, 200) || 'La IA no pudo leer la línea con seguridad');
    if (!codigo) motivos.push('Sin código');
    if (cantidad === null || cantidad <= 0) motivos.push('Cantidad no legible');
    if (precio === null) motivos.push('Precio no legible');
    if (cantidad !== null && precio !== null && importe !== null && Math.abs(cantidad * precio - importe) > Math.max(0.05, importe * 0.01)) {
      motivos.push(`Cantidad × precio (${(cantidad * precio).toFixed(2)}) no coincide con el importe (${importe.toFixed(2)})`);
    }
    return {
      codigo, descripcion: txt(l.descripcion, 200), cantidad, precio_unitario: precio, importe,
      revisar: motivos.length > 0, revisar_motivo: motivos.join('; ').slice(0, 300) || null
    };
  });
  const advertencias = (Array.isArray(d.advertencias) ? d.advertencias : []).map(a => String(a).slice(0, 300)).slice(0, 20);
  const total = num(d.total);
  const suma = lineas.reduce((s, l) => s + (l.importe ?? 0), 0);
  if (total !== null && lineas.length && lineas.every(l => l.importe !== null) && Math.abs(suma - total) > Math.max(1, total * 0.01) && num(d.subtotal) === null) {
    advertencias.push(`La suma de importes (${suma.toFixed(2)}) no coincide con el total de la nota (${total.toFixed(2)}).`);
  }
  return { folio: txt(d.folio, 60), fecha, proveedor: txt(d.proveedor, 120), subtotal: num(d.subtotal), total, lineas, advertencias };
}

module.exports = { leerNota, sugerirPorFoto, normalizarLectura, MODELO };
