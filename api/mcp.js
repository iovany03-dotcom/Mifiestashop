// Servidor MCP (Model Context Protocol) de Mi Fiestashop: permite conectar ChatGPT, Claude u otro
// asistente para buscar, crear y publicar productos y artículos del blog.
//
// Transporte "Streamable HTTP" sin estado: cada POST trae un mensaje JSON-RPC y se responde con JSON.
// Autenticación: una llave de API del panel (API para Desarrolladores, "mfs_live_…"), en el header
//   Authorization: Bearer mfs_live_…   o en la URL   https://www.mifiestashop.com/mcp/mfs_live_…
// (la URL con la llave es para ChatGPT/Claude web, que no dejan poner headers). Los permisos de la
// llave limitan las herramientas: products:read, products:write, categories:read, blog:write,
// inventory:read (consultar existencias y movimientos), inventory:write (crear borradores de movimientos)
// e inventory:approve (aprobar un borrador y aplicarlo al inventario).
const crypto = require('node:crypto');
const { authenticateApiRequest } = require('../lib/api-auth.js');
const { slugify, sanitizeHtml, sbBlog } = require('../lib/blog.js');

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const ORIGIN = 'https://www.mifiestashop.com';
const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];

class ToolError extends Error {}

function sb(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function sbJson(path, opts) {
  const r = await sb(path, opts);
  if (!r.ok) throw new ToolError(`Base de datos respondió ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

const num = v => (v === undefined || v === null || v === '' ? undefined : Number(v));
function urlHttps(u) { const s = String(u || '').trim(); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 600) : null; }

const EXT_IMAGEN = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

// Tipo real por los primeros bytes (no se confía en lo que diga el remitente).
function tipoPorBytes(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.slice(4, 12).toString('latin1').startsWith('ftypavi')) return 'image/avif';
  return null;
}

async function guardarImagen(bytes, carpeta) {
  if (!bytes.length) throw new ToolError('La imagen está vacía.');
  if (bytes.length > 10 * 1024 * 1024) throw new ToolError('La imagen pesa más de 10 MB.');
  const tipo = tipoPorBytes(bytes);
  if (!tipo) throw new ToolError('El archivo no es una imagen compatible (usa JPG, PNG, WEBP, GIF o AVIF).');
  const ruta = `${carpeta}/${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${EXT_IMAGEN[tipo]}`;
  const up = await sb(`/storage/v1/object/assets/${ruta}`, { method: 'POST', headers: { 'Content-Type': tipo }, body: bytes });
  if (!up.ok) throw new ToolError(`No se pudo guardar la imagen (${up.status}).`);
  return `${SUPABASE_URL}/storage/v1/object/public/assets/${ruta}`;
}

// Copia una imagen a nuestro almacenamiento y regresa la URL propia. Acepta:
//   - URL https pública (las que generan los asistentes suelen caducar, por eso se copia)
//   - "data:image/png;base64,…" (imagen generada o editada por el asistente)
//   - archivo adjunto de ChatGPT: { download_url, file_id } (ver openai/fileParams)
async function rehospedarImagen(fuente, carpeta) {
  if (fuente && typeof fuente === 'object' && fuente.download_url) fuente = fuente.download_url;
  const s = String(fuente || '').trim();
  const data = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(s);
  if (data) return guardarImagen(Buffer.from(data[1].replace(/\s+/g, ''), 'base64'), carpeta);
  const src = urlHttps(s);
  if (!src) throw new ToolError(`Imagen inválida: manda una URL https, una imagen en base64 ("data:image/...;base64,...") o adjunta el archivo con la herramienta subir_imagen. Recibí: ${s.slice(0, 80)}`);
  if (src.startsWith(`${SUPABASE_URL}/storage/v1/object/public/`)) return src;
  const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new ToolError(`No se pudo descargar la imagen (${r.status}): ${src.slice(0, 120)}`);
  return guardarImagen(Buffer.from(await r.arrayBuffer()), carpeta);
}

// Imagen que llega a subir_imagen / cambiar_foto_producto en cualquiera de sus formas.
async function imagenDeArgumentos(a, carpeta) {
  if (a.imagen) return rehospedarImagen(a.imagen, carpeta);
  if (a.imagen_base64) {
    const b64 = String(a.imagen_base64).trim();
    return rehospedarImagen(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`, carpeta);
  }
  if (a.imagen_url) return rehospedarImagen(a.imagen_url, carpeta);
  throw new ToolError('Falta la imagen: adjunta el archivo (imagen), o manda imagen_base64 o imagen_url.');
}
const PROPIEDADES_IMAGEN = {
  imagen: { type: 'object', description: 'Archivo de imagen adjunto (ChatGPT lo llena solo al adjuntar el archivo).', properties: { download_url: { type: 'string' }, file_id: { type: 'string' } } },
  imagen_base64: { type: 'string', description: 'La imagen en base64 (o "data:image/png;base64,..."), para imágenes generadas o editadas por el asistente.' },
  imagen_url: { type: 'string', description: 'URL https pública de la imagen.' }
};

function urlProducto(p) {
  return p.link_rewrite ? `${ORIGIN}/${p.id}-${p.link_rewrite}${p.barcode ? '-' + p.barcode : ''}.html` : null;
}
function resumenProducto(p) {
  return {
    id: p.id, nombre: p.name, sku: p.sku, precio: Number(p.price) || 0,
    precio_mayoreo: p.price_mayoreo != null ? Number(p.price_mayoreo) : undefined,
    mayoreo_desde: p.price_mayoreo_desde_unidades || undefined,
    categoria: p.category_label || undefined, activo: p.active !== false,
    imagenes: Array.isArray(p.images) ? p.images : [], url: urlProducto(p) || undefined
  };
}
const CAMPOS = 'id,sku,barcode,name,description,description_short,price,price_mayoreo,price_mayoreo_desde_unidades,category_id,category_label,images,active,link_rewrite,source';


// ---- Inventario ----
// Existencias = ps_stock (base) + movimientos del kardex (pos_stock_moves), igual que el panel (función
// stock_totales). Las entradas de COMPRA no se hacen aquí: solo entran por Recepción de mercancía (con nota
// escaneada). Aquí se crean borradores de salida, traspaso o ajuste de entrada (devolución, corrección o
// conteo); un supervisor los aprueba en el panel (Movimientos → Historial) o, si la llave tiene el permiso
// inventory:approve, con aprobar_movimiento_inventario.
const ALMACENES = ['rumania', 'puebla', 'queretaro'];
const NOMBRE_ALMACEN = { rumania: 'CDMX Rumania', puebla: 'Puebla', queretaro: 'Querétaro' };
function almacenDe(v, campo) {
  const n = String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  if (/rumania|cdmx|popocatepetl/.test(n)) return 'rumania';
  if (n.includes('puebla')) return 'puebla';
  if (n.includes('queretaro')) return 'queretaro';
  throw new ToolError(`${campo}: sucursal no válida ("${v}"). Usa rumania (CDMX), puebla o queretaro.`);
}
async function existencias(ids) {
  const lim = [...new Set(ids.map(Number))].filter(Number.isSafeInteger);
  const out = {};
  lim.forEach(id => { out[id] = { rumania: 0, puebla: 0, queretaro: 0 }; });
  if (!lim.length) return out;
  const rows = await sbJson('/rest/v1/rpc/stock_totales', { method: 'POST', body: JSON.stringify({ p_ids: lim }) });
  (rows || []).forEach(r => { if (out[r.id_product] && ALMACENES.includes(r.almacen)) out[r.id_product][r.almacen] = Number(r.cantidad) || 0; });
  return out;
}
const ERRORES_MOV = {
  tipo_invalido: 'Tipo de movimiento no válido.', sin_productos: 'Faltan las partidas (productos y cantidades).',
  bodega_invalida: 'Sucursal de origen/destino no válida.', partida_invalida: 'Cada partida necesita id_product y una cantidad entera mayor a 0 (máximo 99,999).',
  no_borrador: 'Ese movimiento ya no es un borrador (ya se aprobó).', no_encontrado: 'No se encontró ese movimiento.',
  demasiadas_partidas: 'Demasiadas partidas en un solo movimiento (máximo 500).',
  recepcion_cerrada: 'Esa recepción ya está cerrada, cancelada o procesándose.',
  nada_que_ingresar: 'No hay renglones listos para ingresar: falta identificar el producto, contar, o resolver diferencias/dañadas (eso lo hace un supervisor en el panel).',
  linea_no_lista: 'Alguno de los renglones pedidos no está listo para ingresar (falta identificar, contar o resolver diferencias).'
};
function errorMovimiento(e) {
  const m = String(e && e.message || '');
  for (const [k, v] of Object.entries(ERRORES_MOV)) if (m.includes(k)) return new ToolError(v);
  if (/INGRESO NO PERMITIDO/i.test(m)) return new ToolError('INGRESO NO PERMITIDO: la mercancía comprada solo entra por Recepción de mercancía (con la nota del proveedor). Por aquí solo se pueden hacer ajustes de entrada por devolución, corrección o conteo.');
  return e;
}
function resumenMovimiento(d) {
  return { folio: d.folio, tipo: d.tipo, estado: d.estado, desde: d.origen ? NOMBRE_ALMACEN[d.origen] : undefined, hacia: d.destino ? NOMBRE_ALMACEN[d.destino] : undefined,
    motivo: d.motivo, partidas: (d.items || []).map(i => ({ id_product: i.id_product, nombre: i.name, cantidad: i.qty })),
    creado_por: d.creado_por, aprobado_por: d.aprobado_por || undefined };
}
const PROPIEDADES_PARTIDAS = { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['id_product', 'cantidad'], properties: { id_product: { type: 'integer', description: 'id del producto (de buscar_productos)' }, cantidad: { type: 'integer', minimum: 1, description: 'Piezas (entero)' } } } };

// Recepción completa (cabecera + renglones) por folio, con la función recep_json del panel.
async function recepcionPorFolio(folio) {
  const f = String(folio || '').trim();
  if (!/^REC-[0-9A-Za-z-]{4,30}$/.test(f)) throw new ToolError('Folio de recepción inválido (ej. REC-261020-0003).');
  const [r] = await sbJson(`/rest/v1/recepciones?select=id,estado&folio=eq.${encodeURIComponent(f)}`);
  if (!r) throw new ToolError('No se encontró esa recepción.');
  const j = await sbJson('/rest/v1/rpc/recep_json', { method: 'POST', body: JSON.stringify({ p_id: r.id }) });
  return { ...r, json: j };
}
function estadoRenglon(l) {
  if (l.ingresado_at) return 'ingresado';
  if (!l.id_product || l.revisar) return 'falta identificar el producto';
  if (l.cantidad_recibida == null) return 'falta contar';
  if (l.incidencia && !l.diferencia_resuelta) return 'diferencia o dañadas sin resolver (supervisor)';
  return 'listo para ingresar';
}
function detalleRecepcion(r) {
  const j = r.json || {}, c = j.recepcion || {};
  return {
    recepcion: { folio: c.folio, proveedor: c.proveedor, sucursal: NOMBRE_ALMACEN[c.almacen] || c.almacen, estado: c.estado, nota: c.nota_folio || undefined, total_nota: c.nota_total != null ? Number(c.nota_total) : undefined },
    renglones: (j.lineas || []).map(l => ({
      id_linea: l.id, renglon: l.renglon, codigo: l.codigo, descripcion: l.descripcion || undefined, producto: l.producto ? l.producto.name : undefined,
      cantidad_nota: l.cantidad_nota != null ? Number(l.cantidad_nota) : undefined, piezas_esperadas: l.esperado_piezas != null ? Number(l.esperado_piezas) : undefined,
      piezas_contadas: l.cantidad_recibida != null ? Number(l.cantidad_recibida) : undefined, danadas: Number(l.danadas) || 0, diferencia: l.diferencia != null ? Number(l.diferencia) : undefined,
      ingresado: !!l.ingresado_at, estado: estadoRenglon(l)
    }))
  };
}

const TOOLS_INVENTARIO = [
  {
    name: 'consultar_inventario', scope: 'inventory:read',
    description: 'Existencias de uno o varios productos por sucursal (CDMX Rumania, Puebla, Querétaro). Manda ids de producto o un texto para buscar por nombre.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 50 }, texto: { type: 'string', description: 'Nombre o SKU a buscar' }, limite: { type: 'integer', minimum: 1, maximum: 30 } } },
    annotations: { readOnlyHint: true },
    async run(a) {
      let prods;
      if (Array.isArray(a.ids) && a.ids.length) {
        const ids = a.ids.map(Number).filter(Number.isSafeInteger).slice(0, 50);
        prods = await sbJson(`/rest/v1/catalogo_productos?select=id,name,sku,active&id=in.(${ids.join(',')})`);
      } else {
        const t = String(a.texto || '').replace(/[%*,()]/g, ' ').trim().slice(0, 80);
        if (!t) throw new ToolError('Manda ids de producto o un texto para buscar.');
        const q = encodeURIComponent(`*${t}*`);
        prods = await sbJson(`/rest/v1/catalogo_productos?select=id,name,sku,active&or=(name.ilike.${q},sku.ilike.${q})&order=name.asc&limit=${Math.min(parseInt(a.limite, 10) || 15, 30)}`);
      }
      const ex = await existencias(prods.map(p => p.id));
      return { productos: prods.map(p => ({ id: p.id, nombre: p.name, activo: p.active !== false,
        existencias: { 'CDMX Rumania': ex[p.id].rumania, Puebla: ex[p.id].puebla, Querétaro: ex[p.id].queretaro }, total: ex[p.id].rumania + ex[p.id].puebla + ex[p.id].queretaro })) };
    }
  },
  {
    name: 'listar_movimientos_inventario', scope: 'inventory:read',
    description: 'Lista movimientos de inventario (borradores pendientes de aprobar o ya aprobados): folio, tipo, sucursales, motivo y partidas.',
    inputSchema: { type: 'object', properties: { estado: { type: 'string', enum: ['borrador', 'aprobado'], description: 'Por defecto borrador (pendientes)' }, limite: { type: 'integer', minimum: 1, maximum: 50 } } },
    annotations: { readOnlyHint: true },
    async run(a) {
      const estado = a.estado === 'aprobado' ? 'aprobado' : 'borrador';
      const rows = await sbJson(`/rest/v1/mov_documentos?select=*&estado=eq.${estado}&order=creado_at.desc&limit=${Math.min(parseInt(a.limite, 10) || 20, 50)}`);
      return { total: rows.length, movimientos: rows.map(resumenMovimiento) };
    }
  },
  {
    name: 'crear_movimiento_inventario', scope: 'inventory:write',
    description: 'Crea un BORRADOR de movimiento de inventario; no cambia las existencias hasta que se apruebe. tipo "salida" (merma, regalo, consumo…: pide desde y motivo), "traspaso" (desde una sucursal hacia otra) o "ajuste_entrada" (devolución, corrección o conteo: pide hacia, tipo_ajuste y motivo de al menos 5 letras). Las compras NO se registran aquí: entran por Recepción de mercancía. Sucursales: rumania (CDMX), puebla, queretaro.',
    inputSchema: {
      type: 'object', required: ['tipo', 'partidas'],
      properties: {
        tipo: { type: 'string', enum: ['salida', 'traspaso', 'ajuste_entrada'] },
        desde: { type: 'string', description: 'Sucursal de origen (salida y traspaso)' },
        hacia: { type: 'string', description: 'Sucursal de destino (traspaso y ajuste_entrada)' },
        tipo_ajuste: { type: 'string', enum: ['devolucion', 'correccion', 'conteo'], description: 'Solo para ajuste_entrada' },
        motivo: { type: 'string', description: 'Motivo claro (se guarda en el movimiento)' },
        partidas: PROPIEDADES_PARTIDAS
      }
    },
    annotations: { destructiveHint: false },
    async run(a, ctx) {
      const tipo = ['salida', 'traspaso', 'ajuste_entrada'].includes(a.tipo) ? a.tipo : null;
      if (!tipo) throw new ToolError('tipo debe ser salida, traspaso o ajuste_entrada.');
      const origen = tipo === 'ajuste_entrada' ? null : almacenDe(a.desde, 'desde');
      const destino = tipo === 'salida' ? null : almacenDe(a.hacia, 'hacia');
      const detalle = String(a.motivo || '').trim().slice(0, 250);
      if (!detalle) throw new ToolError('Falta el motivo.');
      let motivo = detalle;
      if (tipo === 'ajuste_entrada') {
        if (!['devolucion', 'correccion', 'conteo'].includes(a.tipo_ajuste)) throw new ToolError('Un ajuste de entrada necesita tipo_ajuste: devolucion, correccion o conteo.');
        if (detalle.length < 5) throw new ToolError('El motivo del ajuste debe tener al menos 5 caracteres.');
        motivo = `${a.tipo_ajuste}: ${detalle}`;
      }
      const partidas = Array.isArray(a.partidas) ? a.partidas.slice(0, 100) : [];
      if (!partidas.length) throw new ToolError('Faltan las partidas.');
      const items = partidas.map(p => ({ id_product: Number(p.id_product), qty: Number(p.cantidad) }));
      if (items.some(i => !Number.isSafeInteger(i.id_product) || !Number.isInteger(i.qty) || i.qty <= 0)) throw new ToolError(ERRORES_MOV.partida_invalida);
      const prods = await sbJson(`/rest/v1/catalogo_productos?select=id,name,sku&id=in.(${items.map(i => i.id_product).join(',')})`);
      const porId = new Map(prods.map(p => [p.id, p]));
      const falta = items.filter(i => !porId.has(i.id_product)).map(i => i.id_product);
      if (falta.length) throw new ToolError(`No existen estos productos: ${falta.join(', ')}.`);
      items.forEach(i => { i.name = porId.get(i.id_product).name; i.sku = porId.get(i.id_product).sku; });
      let advertencias = [];
      if (origen) {
        const ex = await existencias(items.map(i => i.id_product));
        advertencias = items.filter(i => i.qty > ex[i.id_product][origen]).map(i => `${i.name}: pides ${i.qty} y en ${NOMBRE_ALMACEN[origen]} hay ${ex[i.id_product][origen]}.`);
      }
      let doc;
      try {
        doc = await sbJson('/rest/v1/rpc/mov_doc_save_core', { method: 'POST', body: JSON.stringify({ p_id: null, p_tipo: tipo === 'ajuste_entrada' ? 'entrada' : tipo, p_origen: origen, p_destino: destino, p_motivo: motivo, p_items: items, p_por: `Asistente (MCP: ${ctx.key.nombre})` }) });
      } catch (e) { throw errorMovimiento(e); }
      return { creado: true, ...resumenMovimiento(doc), advertencias_existencias: advertencias.length ? advertencias : undefined,
        siguiente_paso: 'Es un borrador: el inventario NO ha cambiado. Un supervisor lo aprueba en el panel (Movimientos de inventario → Historial → Aprobar)' + (tieneScope(ctx.key.scopes, 'inventory:approve') ? ', o puedes aprobarlo con aprobar_movimiento_inventario si el usuario lo confirma.' : '.') };
    }
  },
  {
    name: 'aprobar_movimiento_inventario', scope: 'inventory:approve',
    description: 'Aprueba un borrador de movimiento (salida, traspaso o ajuste de entrada, por su folio) y lo APLICA al inventario: no se puede deshacer desde aquí (solo revirtiéndolo en el panel). Úsalo únicamente cuando el usuario lo pida de forma explícita, mostrándole antes el movimiento; manda confirmar=true. Las salidas y traspasos se rechazan si no hay existencia suficiente.',
    inputSchema: { type: 'object', required: ['folio', 'confirmar'], properties: { folio: { type: 'string', description: 'Folio del borrador, ej. SAL-261022-0001' }, confirmar: { type: 'boolean', description: 'true = el usuario confirmó aplicar este movimiento' } } },
    annotations: { destructiveHint: true },
    async run(a, ctx) {
      if (a.confirmar !== true) throw new ToolError('Para aprobar necesito confirmar=true, después de que el usuario confirme el movimiento.');
      const folio = String(a.folio || '').trim();
      if (!/^[A-Z]{2,3}-[A-Za-z0-9-]{3,40}$/.test(folio)) throw new ToolError('Folio inválido.');
      const [d] = await sbJson(`/rest/v1/mov_documentos?select=*&folio=eq.${encodeURIComponent(folio)}`);
      if (!d) throw new ToolError('No se encontró ese movimiento.');
      if (d.estado !== 'borrador') throw new ToolError(`Ese movimiento ya está ${d.estado}.`);
      const origen = d.tipo === 'entrada' ? null : d.origen;
      if (origen) {
        const necesita = {};
        (d.items || []).forEach(i => { necesita[i.id_product] = (necesita[i.id_product] || 0) + Number(i.qty); });
        const ex = await existencias(Object.keys(necesita));
        const corto = (d.items || []).filter((i, k, arr) => arr.findIndex(x => x.id_product === i.id_product) === k && necesita[i.id_product] > (ex[i.id_product] || {})[origen]);
        if (corto.length) throw new ToolError(`No hay existencia suficiente en ${NOMBRE_ALMACEN[origen]} para: ` + corto.map(i => `${i.name} (necesita ${necesita[i.id_product]}, hay ${ex[i.id_product][origen]})`).join('; ') + '.');
      }
      let aprobado;
      try {
        aprobado = await sbJson('/rest/v1/rpc/mov_doc_approve_core', { method: 'POST', body: JSON.stringify({ p_id: d.id, p_por: `Asistente (MCP: ${ctx.key.nombre})` }) });
      } catch (e) { throw errorMovimiento(e); }
      const ids = (aprobado.items || []).map(i => i.id_product);
      const ex = await existencias(ids);
      return { aprobado: true, ...resumenMovimiento(aprobado),
        existencias_ahora: (aprobado.items || []).map(i => ({ nombre: i.name, 'CDMX Rumania': ex[i.id_product].rumania, Puebla: ex[i.id_product].puebla, Querétaro: ex[i.id_product].queretaro })) };
    }
  },
  {
    name: 'listar_recepciones', scope: 'inventory:read',
    description: 'Recepciones de mercancía (compras con nota del proveedor): folio, proveedor, sucursal, estado y total de la nota. Por defecto las que aún no se ingresan al inventario.',
    inputSchema: { type: 'object', properties: { estado: { type: 'string', enum: ['pendientes', 'pendiente_autorizacion', 'con_diferencias', 'pendiente_conteo', 'pendiente_identificacion', 'parcial', 'conciliada', 'cancelada'], description: 'Por defecto "pendientes" (todas las abiertas)' }, limite: { type: 'integer', minimum: 1, maximum: 50 } } },
    annotations: { readOnlyHint: true },
    async run(a) {
      const est = a.estado && a.estado !== 'pendientes' ? `estado=eq.${encodeURIComponent(String(a.estado).replace(/[^a-z_]/g, ''))}` : 'estado=in.(borrador,procesando,pendiente_identificacion,pendiente_conteo,con_diferencias,pendiente_autorizacion,parcial)';
      const rows = await sbJson(`/rest/v1/recepciones?select=id,folio,almacen,estado,nota_folio,nota_fecha,nota_total,creado_por,created_at,proveedor_id&${est}&order=id.desc&limit=${Math.min(parseInt(a.limite, 10) || 20, 50)}`);
      const provs = rows.length ? await sbJson(`/rest/v1/proveedores_compra?select=id,nombre&id=in.(${[...new Set(rows.map(r => r.proveedor_id))].join(',')})`) : [];
      const nombre = new Map(provs.map(p => [p.id, p.nombre]));
      return { total: rows.length, recepciones: rows.map(r => ({ folio: r.folio, proveedor: nombre.get(r.proveedor_id) || '', sucursal: NOMBRE_ALMACEN[r.almacen] || r.almacen, estado: r.estado, nota: r.nota_folio || undefined, total_nota: r.nota_total != null ? Number(r.nota_total) : undefined, creada_por: r.creado_por })) };
    }
  },
  {
    name: 'ver_recepcion', scope: 'inventory:read',
    description: 'Detalle de una recepción de mercancía por su folio: renglones de la nota, producto vinculado, piezas esperadas, contadas, dañadas, diferencia y si ya ingresó al inventario.',
    inputSchema: { type: 'object', required: ['folio'], properties: { folio: { type: 'string', description: 'Ej. REC-261020-0003' } } },
    annotations: { readOnlyHint: true },
    async run(a) { return detalleRecepcion(await recepcionPorFolio(a.folio)); }
  },
  {
    name: 'autorizar_ingreso_recepcion', scope: 'inventory:approve',
    description: 'Autoriza el ingreso al inventario de una recepción de mercancía (la compra con su nota): entra lo contado menos lo dañado de los renglones que ya están identificados, contados y sin diferencias pendientes. Úsalo solo cuando el usuario lo pida de forma explícita, mostrándole antes el detalle (ver_recepcion); manda confirmar=true. No resuelve diferencias ni cuenta: eso se hace en el panel.',
    inputSchema: { type: 'object', required: ['folio', 'confirmar'], properties: { folio: { type: 'string' }, confirmar: { type: 'boolean', description: 'true = el usuario confirmó el ingreso' }, renglones: { type: 'array', items: { type: 'integer' }, description: 'ids de línea (campo id_linea de ver_recepcion) para ingresar solo algunos; si se omite entran todos los que estén listos' } } },
    annotations: { destructiveHint: true },
    async run(a, ctx) {
      if (a.confirmar !== true) throw new ToolError('Para autorizar necesito confirmar=true, después de que el usuario confirme el ingreso.');
      const r = await recepcionPorFolio(a.folio);
      if (['cancelada', 'conciliada'].includes(r.estado)) throw new ToolError(`Esa recepción ya está ${r.estado === 'conciliada' ? 'conciliada (todo ingresado)' : 'cancelada'}.`);
      const lineas = Array.isArray(a.renglones) && a.renglones.length ? a.renglones.map(Number).filter(Number.isSafeInteger) : null;
      let n;
      try {
        n = await sbJson('/rest/v1/rpc/recep_autorizar_core', { method: 'POST', body: JSON.stringify({ p_id: r.id, p_lineas: lineas, p_por: `Asistente (MCP: ${ctx.key.nombre})` }) });
      } catch (e) { throw errorMovimiento(e); }
      const d = detalleRecepcion(await recepcionPorFolio(a.folio));
      return { autorizado: true, renglones_ingresados: n, recepcion: d.recepcion, pendientes: d.renglones.filter(x => !x.ingresado).map(x => ({ id_linea: x.id_linea, codigo: x.codigo, producto: x.producto, falta: x.estado })) };
    }
  }
];

// ---- Herramientas ----
const TOOLS = [
  {
    name: 'buscar_productos', scope: 'products:read',
    description: 'Busca productos del catálogo de Mi Fiestashop por nombre o SKU. Regresa id, nombre, precio, precio de mayoreo, categoría, si está activo, fotos y liga.',
    inputSchema: { type: 'object', properties: { texto: { type: 'string', description: 'Palabras a buscar, ej. "collar hawaiano"' }, incluir_inactivos: { type: 'boolean' }, limite: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['texto'] },
    annotations: { readOnlyHint: true },
    async run(a) {
      const t = String(a.texto || '').replace(/[%*,()]/g, ' ').trim().slice(0, 80);
      if (!t) throw new ToolError('Escribe qué buscar.');
      const lim = Math.min(Math.max(parseInt(a.limite, 10) || 15, 1), 50);
      const q = encodeURIComponent(`*${t}*`);
      const rows = await sbJson(`/rest/v1/catalogo_productos?select=${CAMPOS}&or=(name.ilike.${q},sku.ilike.${q})${a.incluir_inactivos ? '' : '&active=eq.true'}&order=name.asc&limit=${lim}`);
      return { total: rows.length, productos: rows.map(resumenProducto) };
    }
  },
  {
    name: 'ver_producto', scope: 'products:read',
    description: 'Detalle completo de un producto por su id (incluye descripción).',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
    async run(a) {
      const id = Number(a.id);
      if (!Number.isSafeInteger(id)) throw new ToolError('id inválido');
      const [p] = await sbJson(`/rest/v1/catalogo_productos?select=${CAMPOS}&id=eq.${id}`);
      if (!p) throw new ToolError('No existe un producto con ese id.');
      return { ...resumenProducto(p), descripcion: p.description || p.description_short || '' };
    }
  },
  {
    name: 'listar_categorias', scope: 'categories:read',
    description: 'Lista las categorías de la tienda (id y nombre) para asignarlas a un producto.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      const rows = await sbJson('/rest/v1/ps_categorias?select=id,name,active&order=name.asc');
      return { categorias: rows.filter(c => c.active !== false).map(c => ({ id: c.id, nombre: c.name })) };
    }
  },
  {
    name: 'crear_producto', scope: 'products:write',
    description: 'Crea un producto nuevo en el catálogo. Por seguridad queda OCULTO en la tienda (borrador) salvo que publicar=true. Las fotos se dan como URLs https y se copian al almacenamiento de la tienda.',
    inputSchema: {
      type: 'object', required: ['nombre', 'precio'],
      properties: {
        nombre: { type: 'string', maxLength: 200 }, precio: { type: 'number', exclusiveMinimum: 0, description: 'Precio de menudeo en pesos (MXN) por pieza' },
        descripcion: { type: 'string', description: 'Descripción para la tienda (texto o HTML sencillo)' },
        sku: { type: 'string', description: 'Código o palabras clave; si se omite se genera' },
        categoria_id: { type: 'integer', description: 'id de listar_categorias' },
        precio_mayoreo: { type: 'number' }, mayoreo_desde: { type: 'integer', description: 'Piezas mínimas para precio de mayoreo' },
        imagenes: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        costo_compra: { type: 'number', description: 'Costo de compra (privado, no se muestra en la tienda)' },
        publicar: { type: 'boolean', description: 'true para que se vea en la tienda de inmediato' }
      }
    },
    async run(a) {
      const nombre = String(a.nombre || '').trim().slice(0, 200);
      const precio = Number(a.precio);
      if (!nombre) throw new ToolError('Falta el nombre.');
      if (!(precio > 0)) throw new ToolError('El precio debe ser mayor a 0.');
      const imagenes = [];
      for (const u of (Array.isArray(a.imagenes) ? a.imagenes : []).slice(0, 10)) imagenes.push(await rehospedarImagen(u, 'productos'));
      let categoria = {};
      if (num(a.categoria_id) !== undefined) {
        const [c] = await sbJson(`/rest/v1/ps_categorias?select=id,name&id=eq.${Number(a.categoria_id)}`);
        if (!c) throw new ToolError('No existe esa categoría; usa listar_categorias.');
        categoria = { category_id: c.id, category_label: c.name };
      }
      const publicar = a.publicar === true;
      const id = 9000000000000 + Date.now();
      const row = {
        id, name: nombre, sku: String(a.sku || '').trim().slice(0, 200) || nombre.toLowerCase().slice(0, 120),
        description: a.descripcion ? sanitizeHtml(a.descripcion).slice(0, 20000) : null,
        price: Math.round(precio * 100) / 100,
        price_mayoreo: num(a.precio_mayoreo) > 0 ? Math.round(Number(a.precio_mayoreo) * 100) / 100 : null,
        price_mayoreo_desde_unidades: num(a.mayoreo_desde) > 1 ? parseInt(a.mayoreo_desde, 10) : null,
        costo_compra: num(a.costo_compra) > 0 ? Number(a.costo_compra) : null,
        images: imagenes.length ? imagenes : null, legacy_image_url: imagenes[0] || null,
        active: publicar, active_override: publicar, source: 'manual', link_rewrite: slugify(nombre),
        ...categoria, updated_at: new Date().toISOString()
      };
      const [p] = await sbJson('/rest/v1/catalogo_productos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return { creado: true, visible_en_tienda: publicar, producto: resumenProducto(p), nota: publicar ? 'Ya está en la tienda.' : 'Quedó oculto: usa actualizar_producto con activo=true para publicarlo.' };
    }
  },
  {
    name: 'actualizar_producto', scope: 'products:write',
    description: 'Cambia datos de un producto existente: nombre, descripción, precio, precio de mayoreo, categoría, fotos (reemplaza la lista) o activo (publicar/ocultar). Solo se cambian los campos enviados.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'integer' }, nombre: { type: 'string' }, descripcion: { type: 'string' }, precio: { type: 'number', exclusiveMinimum: 0 },
        precio_mayoreo: { type: 'number' }, mayoreo_desde: { type: 'integer' }, categoria_id: { type: 'integer' },
        imagenes: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Reemplaza TODAS las fotos. URLs https o "data:image/...;base64,...". Para cambiar solo una usa cambiar_foto_producto.' }, activo: { type: 'boolean' }
      }
    },
    async run(a) {
      const id = Number(a.id);
      if (!Number.isSafeInteger(id)) throw new ToolError('id inválido');
      const [actual] = await sbJson(`/rest/v1/catalogo_productos?select=id&id=eq.${id}`);
      if (!actual) throw new ToolError('No existe un producto con ese id.');
      const cambio = {};
      if (a.nombre !== undefined) { const n = String(a.nombre).trim().slice(0, 200); if (!n) throw new ToolError('El nombre no puede quedar vacío.'); cambio.name = n; }
      if (a.descripcion !== undefined) cambio.description = sanitizeHtml(a.descripcion).slice(0, 20000);
      if (a.precio !== undefined) { if (!(Number(a.precio) > 0)) throw new ToolError('Precio inválido.'); cambio.price = Math.round(Number(a.precio) * 100) / 100; }
      if (a.precio_mayoreo !== undefined) cambio.price_mayoreo = Number(a.precio_mayoreo) > 0 ? Math.round(Number(a.precio_mayoreo) * 100) / 100 : null;
      if (a.mayoreo_desde !== undefined) cambio.price_mayoreo_desde_unidades = parseInt(a.mayoreo_desde, 10) > 1 ? parseInt(a.mayoreo_desde, 10) : null;
      if (a.categoria_id !== undefined) {
        const [c] = await sbJson(`/rest/v1/ps_categorias?select=id,name&id=eq.${Number(a.categoria_id)}`);
        if (!c) throw new ToolError('No existe esa categoría.');
        Object.assign(cambio, { category_id: c.id, category_label: c.name });
      }
      if (a.imagenes !== undefined) {
        const imgs = [];
        for (const u of (Array.isArray(a.imagenes) ? a.imagenes : []).slice(0, 10)) imgs.push(await rehospedarImagen(u, 'productos'));
        cambio.images = imgs.length ? imgs : null; cambio.legacy_image_url = imgs[0] || null;
      }
      if (a.activo !== undefined) { cambio.active = a.activo === true; cambio.active_override = a.activo === true; }
      if (!Object.keys(cambio).length) throw new ToolError('No enviaste ningún campo para cambiar.');
      cambio.updated_at = new Date().toISOString();
      const [p] = await sbJson(`/rest/v1/catalogo_productos?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(cambio) });
      // La tienda usa el nombre/descripción/fotos de productos_migrados cuando existen: se actualizan ahí también.
      const mig = {};
      if (cambio.name) mig.name = cambio.name;
      if (cambio.description !== undefined) mig.description = cambio.description;
      if (cambio.images !== undefined) mig.images = cambio.images;
      if (cambio.category_label) mig.category_label = cambio.category_label;
      if (Object.keys(mig).length) await sb(`/rest/v1/productos_migrados?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(mig) });
      return { actualizado: true, producto: resumenProducto(p) };
    }
  },
  {
    name: 'subir_imagen', scope: 'products:write',
    description: 'Sube una imagen (archivo adjunto, generada/editada por ti en base64, o URL) al almacenamiento de la tienda y regresa su URL https permanente, para usarla en crear_producto, actualizar_producto o el blog.',
    inputSchema: { type: 'object', properties: { ...PROPIEDADES_IMAGEN } },
    _meta: { 'openai/fileParams': ['imagen'] },
    async run(a) { return { url: await imagenDeArgumentos(a, 'productos') }; }
  },
  {
    name: 'cambiar_foto_producto', scope: 'products:write',
    description: 'Reemplaza, agrega o quita UNA foto de un producto sin tocar las demás. posicion empieza en 1 (1 = foto principal). accion: "reemplazar" (por defecto), "agregar" (al final, o en posicion) o "quitar".',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'integer' }, posicion: { type: 'integer', minimum: 1, maximum: 10 },
        accion: { type: 'string', enum: ['reemplazar', 'agregar', 'quitar'] }, ...PROPIEDADES_IMAGEN
      }
    },
    _meta: { 'openai/fileParams': ['imagen'] },
    async run(a) {
      const id = Number(a.id);
      if (!Number.isSafeInteger(id)) throw new ToolError('id inválido');
      const [p] = await sbJson(`/rest/v1/catalogo_productos?select=id,images&id=eq.${id}`);
      if (!p) throw new ToolError('No existe un producto con ese id.');
      const [m] = await sbJson(`/rest/v1/productos_migrados?select=images&id=eq.${id}`).catch(() => []);
      const a1 = Array.isArray(p.images) ? p.images : [], a2 = m && Array.isArray(m.images) ? m.images : [];
      const fotos = (a2.length > a1.length ? a2 : a1).slice();  // la tienda muestra la lista más completa
      const accion = a.accion || 'reemplazar';
      const pos = Math.max(1, parseInt(a.posicion, 10) || 1);
      if (accion === 'quitar') {
        if (pos > fotos.length) throw new ToolError(`El producto solo tiene ${fotos.length} fotos.`);
        fotos.splice(pos - 1, 1);
      } else {
        const url = await imagenDeArgumentos(a, 'productos');
        if (accion === 'agregar') { if (fotos.length >= 10) throw new ToolError('El producto ya tiene 10 fotos.'); fotos.splice(a.posicion ? pos - 1 : fotos.length, 0, url); }
        else if (pos > fotos.length) fotos.push(url);
        else fotos[pos - 1] = url;
      }
      const cambio = { images: fotos.length ? fotos : null, legacy_image_url: fotos[0] || null, updated_at: new Date().toISOString() };
      const [n] = await sbJson(`/rest/v1/catalogo_productos?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(cambio) });
      if (m) await sb(`/rest/v1/productos_migrados?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ images: cambio.images }) });
      return { actualizado: true, fotos, producto: resumenProducto(n) };
    }
  },
  {
    name: 'listar_articulos_blog', scope: 'blog:write',
    description: 'Lista los artículos del blog (publicados y borradores).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      const posts = await sbBlog('select=id,slug,titulo,estado,publicado_at,palabra_clave&order=updated_at.desc&limit=200', process.env.SUPABASE_SERVICE_ROLE_KEY);
      return { articulos: posts.map(p => ({ ...p, url: p.estado === 'publicado' ? `${ORIGIN}/blog/${p.slug}` : undefined })) };
    }
  },
  {
    name: 'crear_articulo_blog', scope: 'blog:write',
    description: 'Crea (o actualiza, si das id) un artículo del blog para SEO. El contenido va en HTML sencillo: <h2>, <h3>, <p>, <ul>, <a href="/…">, <img>. Queda como borrador salvo publicar=true. Recomendado: 800+ palabras, palabra clave en título e introducción, enlaces a productos de la tienda.',
    inputSchema: {
      type: 'object', required: ['titulo', 'contenido_html'],
      properties: {
        id: { type: 'integer', description: 'Para editar un artículo existente' },
        titulo: { type: 'string', maxLength: 200 }, contenido_html: { type: 'string' },
        resumen: { type: 'string', maxLength: 400 }, palabra_clave: { type: 'string' },
        meta_title: { type: 'string', maxLength: 70 }, meta_description: { type: 'string', maxLength: 170 },
        etiquetas: { type: 'array', items: { type: 'string' } }, imagen_portada: { type: 'string', description: 'URL https de la portada' },
        imagen_alt: { type: 'string' }, autor: { type: 'string' }, slug: { type: 'string' },
        publicar: { type: 'boolean' }, publicar_en: { type: 'string', description: 'Fecha ISO para programar la publicación' }
      }
    },
    async run(a) {
      const titulo = String(a.titulo || '').trim().slice(0, 200);
      if (!titulo) throw new ToolError('Falta el título.');
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const id = num(a.id);
      const publicar = a.publicar === true;
      let fecha = a.publicar_en ? new Date(a.publicar_en) : null;
      if (fecha && isNaN(fecha)) throw new ToolError('publicar_en no es una fecha válida.');
      const row = {
        titulo, contenido: sanitizeHtml(a.contenido_html).slice(0, 200000),
        resumen: a.resumen ? String(a.resumen).slice(0, 400) : null,
        palabra_clave: a.palabra_clave ? String(a.palabra_clave).slice(0, 80) : null,
        meta_title: a.meta_title ? String(a.meta_title).slice(0, 120) : null,
        meta_description: a.meta_description ? String(a.meta_description).slice(0, 320) : null,
        etiquetas: (Array.isArray(a.etiquetas) ? a.etiquetas : []).map(t => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12),
        imagen: a.imagen_portada ? await rehospedarImagen(a.imagen_portada, 'blog') : null,
        imagen_alt: a.imagen_alt ? String(a.imagen_alt).slice(0, 200) : null,
        autor: String(a.autor || 'Equipo Mi Fiestashop').slice(0, 80),
        estado: publicar ? 'publicado' : 'borrador',
        publicado_at: publicar ? (fecha || new Date()).toISOString() : (fecha ? fecha.toISOString() : null),
        actualizado_por: 'Asistente (MCP)', updated_at: new Date().toISOString()
      };
      let slug = slugify(a.slug || titulo) || `articulo-${Date.now()}`;
      const base = slug;
      for (let n = 2; n < 50; n++) {
        const [otro] = await sbBlog(`select=id&slug=eq.${slug}`, key);
        if (!otro || (id && otro.id === id)) break;
        slug = `${base}-${n}`.slice(0, 90);
      }
      row.slug = slug;
      const [p] = id
        ? await sbJson(`/rest/v1/blog_posts?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : await sbJson('/rest/v1/blog_posts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, creado_por: 'Asistente (MCP)' }) });
      if (!p) throw new ToolError('No existe un artículo con ese id.');
      return { guardado: true, id: p.id, estado: p.estado, url: `${ORIGIN}/blog/${p.slug}`, visible: p.estado === 'publicado' && new Date(p.publicado_at) <= new Date() };
    }
  },
  ...TOOLS_INVENTARIO
];

const INSTRUCCIONES = 'Herramientas de Mi Fiestashop (artículos para fiestas, México). Precios en pesos MXN por pieza. Antes de crear un producto busca si ya existe con buscar_productos. Los productos nuevos quedan ocultos salvo que el usuario pida publicarlos. Para el blog escribe en español de México, con <h2> por sección y enlaces a productos de la tienda. Inventario: consulta existencias con consultar_inventario; para cambiarlo crea un borrador con crear_movimiento_inventario (salida, traspaso o ajuste de entrada). Las compras con nota del proveedor se revisan con listar_recepciones / ver_recepcion y, si el usuario lo pide, se ingresan con autorizar_ingreso_recepcion y nunca lo apruebes sin que el usuario lo confirme. Para cambiar una foto usa cambiar_foto_producto (adjunta el archivo o manda la imagen en imagen_base64); no hace falta subirla antes a otro sitio.';

function tieneScope(scopes, s) { return scopes.includes('*') || scopes.includes(s); }

async function atender(msg, scopes, key) {
  const { id, method, params } = msg || {};
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Solicitud inválida');
  if (id === undefined) return null; // notificación (p. ej. notifications/initialized): no lleva respuesta

  if (method === 'initialize') {
    const pedida = params && params.protocolVersion;
    return ok({
      protocolVersion: PROTOCOLOS.includes(pedida) ? pedida : PROTOCOLOS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mifiestashop', title: 'Mi Fiestashop', version: '1.1.0' },
      instructions: INSTRUCCIONES
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: TOOLS.filter(t => tieneScope(scopes, t.scope)).map(({ name, description, inputSchema, annotations, _meta }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}), ...(_meta ? { _meta } : {}) })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === (params && params.name));
    if (!tool) return err(-32602, `Herramienta desconocida: ${params && params.name}`);
    if (!tieneScope(scopes, tool.scope)) return ok({ isError: true, content: [{ type: 'text', text: `Esta llave no tiene el permiso "${tool.scope}". Créala de nuevo en el panel (API para Desarrolladores) con ese permiso.` }] });
    try {
      const data = await tool.run((params && params.arguments) || {}, { key });
      return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
    } catch (e) {
      return ok({ isError: true, content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Error interno: ${e.message}` }] });
    }
  }
  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });
  return err(-32601, `Método no soportado: ${method}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' || req.method === 'DELETE') { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Usa POST (MCP Streamable HTTP).' }); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }

  // La llave puede venir en la URL (/mcp/mfs_live_…) para ChatGPT/Claude web.
  const keyEnUrl = typeof req.query.key === 'string' && /^mfs_live_[a-f0-9]{48}$/.test(req.query.key) ? req.query.key : null;
  if (keyEnUrl && !req.headers.authorization) req.headers.authorization = `Bearer ${keyEnUrl}`;
  const auth = await authenticateApiRequest(req, null);
  if (!auth.ok) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(auth.status || 401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: auth.error } });
    return;
  }
  const scopes = auth.key.scopes;
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return null; } })() : req.body;
  if (!body) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); return; }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => atender(m, scopes, auth.key)))).filter(Boolean);
    if (!out.length) { res.status(202).end(); return; }
    res.status(200).json(out);
    return;
  }
  const out = await atender(body, scopes, auth.key);
  if (!out) { res.status(202).end(); return; }
  res.status(200).json(out);
};

module.exports.TOOLS = TOOLS;
