// Sincronización PrestaShop -> Supabase para Pedidos, Clientes, Carritos,
// Empleados, Categorías, Almacenes y Stock. Se ejecuta cada hora desde
// api/cron-sync-prestashop.js (Vercel Cron). PrestaShop no soporta filtrar
// por fecha de modificación (ni en orders ni en customers — confirmado
// contra la API real), así que:
//   - Clientes: aditivo (solo id > último sincronizado) — captura clientes
//     nuevos; no relee ediciones de clientes ya sincronizados.
//   - Pedidos y Carritos: se re-sincroniza una ventana reciente completa
//     (por id DESC) en cada corrida, así si cambia el estado de un pedido
//     reciente (ej. "Nuevo Pedido" -> "Pago aceptado") se refleja.
//   - Categorías, Almacenes, Empleados: catálogos chicos, refresh completo.
//   - Stock: siempre completo (los valores cambian todo el tiempo, no hay
//     "nuevo id" que perseguir).

const PS_ORDERS_WINDOW = 3000;
const PS_CARTS_WINDOW = 150;

function firstLangValue(field, fallback) {
  if (Array.isArray(field)) {
    for (const entry of field) {
      const v = entry && typeof entry === 'object' ? entry.value : entry;
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
    return fallback;
  }
  if (typeof field === 'string' && field.trim() !== '') return field;
  return fallback;
}

function psHeaders(apiKey) {
  return { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` };
}

async function psFetch(baseUrl, apiKey, path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${baseUrl}${path}${sep}output_format=JSON`;
  const r = await fetch(url, { headers: psHeaders(apiKey) });
  if (!r.ok) throw new Error(`PrestaShop ${path} -> HTTP ${r.status}`);
  return r.json();
}

async function sbUpsert(supabaseUrl, serviceKey, table, rows, conflictCols) {
  if (!rows.length) return;
  const url = `${supabaseUrl}/rest/v1/${table}?on_conflict=${conflictCols}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`upsert ${table} -> HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
}

async function sbGetSyncState(supabaseUrl, serviceKey, dominio) {
  const r = await fetch(`${supabaseUrl}/rest/v1/ps_sync_estado?dominio=eq.${dominio}&select=*`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function sbSetSyncState(supabaseUrl, serviceKey, dominio, lastId, resultado) {
  await fetch(`${supabaseUrl}/rest/v1/ps_sync_estado?on_conflict=dominio`, {
    method: 'POST',
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ dominio, last_synced_id: lastId, last_synced_at: new Date().toISOString(), ultimo_resultado: resultado })
  });
}

// ================= CATEGORÍAS =================
// link_rewrite/description/meta_title/meta_description se suman aquí para
// poder armar URLs propias de categoría (/{id}-{link_rewrite}, igual que
// productos) y su SEO real server-side — antes solo se guardaba id/name,
// suficiente para el sidebar pero no para páginas de categoría indexables.
async function syncCategorias(ctx) {
  const data = await psFetch(ctx.baseUrl, ctx.apiKey, '/api/categories?display=[id,name,id_parent,active,link_rewrite,description,meta_title,meta_description]&limit=0,1000');
  const rows = (data.categories || []).map(c => ({
    id: Number(c.id), name: firstLangValue(c.name, `Categoría ${c.id}`),
    id_parent: c.id_parent ? Number(c.id_parent) : null, active: c.active === '1' || c.active === 1,
    link_rewrite: firstLangValue(c.link_rewrite, null),
    description: firstLangValue(c.description, '').replace(/<[^>]*>/g, '').trim() || null,
    meta_title: firstLangValue(c.meta_title, null),
    meta_description: firstLangValue(c.meta_description, null)
  }));
  await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_categorias', rows, 'id');
  return rows.length;
}

// ================= ALMACENES =================
async function syncAlmacenes(ctx) {
  const data = await psFetch(ctx.baseUrl, ctx.apiKey, '/api/warehouses?display=[id,name]');
  const rows = (data.warehouses || []).map(w => ({ id: Number(w.id), name: String(w.name || '').trim() }));
  await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_almacenes', rows, 'id');
  return rows.length;
}

// ================= EMPLEADOS =================
async function syncEmpleados(ctx) {
  const data = await psFetch(ctx.baseUrl, ctx.apiKey, '/api/employees?display=[id,firstname,lastname,email,active]&limit=0,500');
  const rows = (data.employees || []).map(e => ({
    id: Number(e.id), name: `${e.firstname || ''} ${e.lastname || ''}`.trim() || `Empleado ${e.id}`,
    email: e.email || null, active: e.active === '1' || e.active === 1
  }));
  await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_empleados', rows, 'id');
  return rows.length;
}

// ================= CLIENTES (aditivo) =================
async function syncClientes(ctx) {
  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'clientes');
  const sinceId = state && state.last_synced_id ? Number(state.last_synced_id) : 0;

  const PAGE_SIZE = 500;
  const fields = '[id,firstname,lastname,email,date_add,active,birthday,company,newsletter,optin,note,is_guest]';
  let page = 0, total = 0, maxId = sinceId;
  const startedAt = Date.now();

  // El webservice de PrestaShop no soporta un operador ">" suelto en
  // filter[id] (lo ignora y regresa vacío sin avisar) — solo rangos
  // "[min,max]" o listas "[a|b|c]". Se usa un rango hasta un id máximo
  // bien alto para expresar "mayor que sinceId".
  const MAX_ID = 999999999;
  while (Date.now() - startedAt < ctx.timeBudgetMs) {
    const rangeFilter = encodeURIComponent(`[${sinceId + 1},${MAX_ID}]`);
    const url = `/api/customers?filter[id]=${rangeFilter}&display=${encodeURIComponent(fields)}&sort=[id_ASC]&limit=${page * PAGE_SIZE},${PAGE_SIZE}`;
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, url);
    const batch = data.customers || [];
    if (batch.length === 0) break;

    const rows = batch.map(c => {
      const hasBirthday = c.birthday && !String(c.birthday).startsWith('0000-00-00');
      return {
        id: Number(c.id), name: `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente',
        // rfc/phone/address: no disponibles — la llave de PrestaShop no
        // tiene permiso sobre el recurso "addresses" en este momento
        // ("Resource of type addresses is not allowed with this
        // authentication key"), que es donde vive ese dato.
        email: c.email || null, rfc: null, phone: null, address: null, city: null, postcode: null,
        active: c.active === '1' || c.active === 1, date_add: c.date_add || null,
        birthday: hasBirthday ? c.birthday : null, company: c.company || null,
        newsletter: c.newsletter === '1' || c.newsletter === 1, optin: c.optin === '1' || c.optin === 1,
        note: c.note || null, is_guest: c.is_guest === '1' || c.is_guest === 1
      };
    });
    await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_clientes', rows, 'id');
    total += rows.length;
    maxId = Math.max(maxId, ...rows.map(r => r.id));

    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  if (maxId > sinceId) await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'clientes', maxId, `+${total} nuevos`);
  return total;
}

// ================= PEDIDOS (ventana reciente completa, con líneas de producto) =================
async function syncPedidos(ctx) {
  const fields = '[id,reference,id_customer,current_state,date_add,date_upd,delivery_date,id_shop,id_employee,payment,total_paid,valid,note,id_carrier,total_products,total_discounts,total_shipping,invoice_number,invoice_date,id_cart]';
  const data = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/orders?display=${encodeURIComponent(fields)}&sort=[id_DESC]&limit=0,${PS_ORDERS_WINDOW}`);
  const rawOrders = data.orders || [];
  if (rawOrders.length === 0) return 0;

  // Lookups en bloque (categorías/empleados/tiendas ya viven en las tablas
  // espejo recién sincronizadas; clientes se resuelven aparte por id).
  const [empRes, shopRes, stateRes] = await Promise.all([
    fetch(`${ctx.supabaseUrl}/rest/v1/ps_empleados?select=id,name`, { headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` } }),
    psFetch(ctx.baseUrl, ctx.apiKey, '/api/shops?display=[id,name]'),
    psFetch(ctx.baseUrl, ctx.apiKey, '/api/order_states?display=[id,name]')
  ]);
  const empleados = await empRes.json();
  const empById = {}; (Array.isArray(empleados) ? empleados : []).forEach(e => { empById[e.id] = e.name; });
  const shopById = {}; (shopRes.shops || []).forEach(s => { shopById[s.id] = s.name; });
  const stateById = {}; (stateRes.order_states || []).forEach(s => { stateById[s.id] = firstLangValue(s.name, 'Pendiente'); });

  const customerIds = [...new Set(rawOrders.map(o => o.id_customer))].filter(Boolean);
  const custMap = {};
  const CHUNK = 200;
  for (let i = 0; i < customerIds.length; i += CHUNK) {
    const chunk = customerIds.slice(i, i + CHUNK);
    const filterVal = encodeURIComponent(`[${chunk.join('|')}]`);
    const cdata = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/customers?display=${encodeURIComponent('[id,firstname,lastname]')}&filter[id]=${filterVal}&limit=0,${chunk.length}`);
    (cdata.customers || []).forEach(c => { custMap[c.id] = `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente'; });
  }

  // Líneas de producto de todos los pedidos de la ventana, en bloques de
  // hasta 200 ids por llamada (order_details soporta filter[id_order] con
  // sintaxis OR) — mucho más barato que un detalle por pedido.
  const orderIds = rawOrders.map(o => o.id);
  const itemsByOrder = {};
  const detailFields = '[id_order,product_id,product_name,product_reference,product_quantity,product_price]';
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK);
    const filterVal = encodeURIComponent(`[${chunk.join('|')}]`);
    const ddata = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/order_details?display=${encodeURIComponent(detailFields)}&filter[id_order]=${filterVal}&limit=0,5000`);
    (ddata.order_details || []).forEach(row => {
      const oid = row.id_order;
      if (!itemsByOrder[oid]) itemsByOrder[oid] = [];
      itemsByOrder[oid].push({
        product_id: Number(row.product_id), name: row.product_name || '', sku: row.product_reference || '',
        qty: parseFloat(row.product_quantity || 0), price: parseFloat(row.product_price || 0)
      });
    });
  }

  // El campo "payment" del pedido solo dice el canal ("POS", el nombre del
  // módulo de pago en línea, etc.) — el método real (Efectivo / Débito-
  // Crédito / Transferencia) que se ve en los Reportes POS de PrestaShop
  // vive en el recurso "order_payments", aparte. Se trae en bloque igual
  // que order_details.
  const paymentMethodByOrder = {};
  const paymentFields = '[id_order,payment_method]';
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK);
    const filterVal = encodeURIComponent(`[${chunk.join('|')}]`);
    const pdata = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/order_payments?display=${encodeURIComponent(paymentFields)}&filter[id_order]=${filterVal}&limit=0,5000`);
    (pdata.order_payments || []).forEach(row => {
      if (!paymentMethodByOrder[row.id_order]) paymentMethodByOrder[row.id_order] = row.payment_method || null;
    });
  }

  const rows = rawOrders.map(o => {
    const hasDelivery = o.delivery_date && !String(o.delivery_date).startsWith('0000-00-00');
    const hasInvoiceDate = o.invoice_date && !String(o.invoice_date).startsWith('0000-00-00');
    return {
      id: Number(o.id), reference: o.reference || '', id_customer: Number(o.id_customer) || null,
      customer_name: custMap[o.id_customer] || `Cliente #${o.id_customer}`,
      current_state: Number(o.current_state) || null, state_label: stateById[o.current_state] || 'Pendiente',
      payment: o.payment || '', payment_method: paymentMethodByOrder[o.id] || null, total_paid: parseFloat(o.total_paid || 0),
      id_shop: Number(o.id_shop) || null, shop_name: shopById[o.id_shop] || 'Mi Fiestashop',
      id_employee: Number(o.id_employee) || null, employee_name: empById[o.id_employee] || null,
      date_add: o.date_add || null, date_upd: o.date_upd || null, delivery_date: hasDelivery ? o.delivery_date : null,
      valid: o.valid === '1' || o.valid === 1, note: o.note || null, id_carrier: Number(o.id_carrier) || null,
      total_products: parseFloat(o.total_products || 0), total_discounts: parseFloat(o.total_discounts || 0),
      total_shipping: parseFloat(o.total_shipping || 0), invoice_number: o.invoice_number && o.invoice_number !== '0' ? String(o.invoice_number) : null,
      invoice_date: hasInvoiceDate ? o.invoice_date : null, id_cart: Number(o.id_cart) || null,
      items: itemsByOrder[o.id] || []
    };
  });

  const CHUNK2 = 500;
  for (let i = 0; i < rows.length; i += CHUNK2) {
    await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_pedidos', rows.slice(i, i + CHUNK2), 'id');
  }
  await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'pedidos', rows[0]?.id || 0, `ventana de ${rows.length}`);
  return rows.length;
}

// ================= CARRITOS (ventana reciente completa, con items) =================
async function syncCarritos(ctx) {
  const cartsData = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/carts?display=[id,id_customer,date_add,date_upd]&sort=[id_DESC]&limit=0,${PS_CARTS_WINDOW}`);
  const rawCarts = cartsData.carts || [];
  if (rawCarts.length === 0) return 0;

  const [ordersData, custData] = await Promise.all([
    psFetch(ctx.baseUrl, ctx.apiKey, '/api/orders?display=[id,id_cart,reference]&limit=0,2000'),
    (async () => {
      const ids = [...new Set(rawCarts.map(c => c.id_customer))].filter(Boolean);
      if (ids.length === 0) return { customers: [] };
      const filterVal = encodeURIComponent(`[${ids.join('|')}]`);
      return psFetch(ctx.baseUrl, ctx.apiKey, `/api/customers?display=${encodeURIComponent('[id,firstname,lastname,email]')}&filter[id]=${filterVal}&limit=0,${ids.length}`);
    })()
  ]);
  const orderByCart = {};
  (ordersData.orders || []).forEach(o => { if (o.id_cart && o.id_cart !== '0') orderByCart[o.id_cart] = o.reference || `#${o.id}`; });
  const custById = {};
  (custData.customers || []).forEach(c => { custById[c.id] = { name: `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Cliente', email: c.email || '' }; });

  // El detalle de cada carrito es una llamada aparte (no hay bulk como en
  // order_details), así que con muchos carritos esto puede tardar — si el
  // presupuesto de tiempo se agota a la mitad, se corta aquí y se sigue con
  // los carritos ya traídos en vez de perder toda la corrida (el resto de
  // la función solo necesita cartsWithRawItems, no rawCarts completo).
  const cartsStartedAt = Date.now();
  const cartsWithRawItems = [];
  for (const c of rawCarts) {
    if (Date.now() - cartsStartedAt > ctx.timeBudgetMs) break;
    let items = [];
    try {
      const detail = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/carts/${c.id}`);
      const cartRows = detail.cart?.associations?.cart_rows;
      const raw = Array.isArray(cartRows) ? cartRows : (cartRows ? [cartRows] : []);
      items = raw.map(row => ({ id_product: Number(row.id_product), qty: parseInt(row.quantity || 1, 10) }));
    } catch (e) { /* se guarda sin items si falla el detalle */ }
    cartsWithRawItems.push({ cart: c, items });
  }

  // Se resuelven nombre/sku/precio/imagen de cada producto una sola vez por
  // corrida (no en cada carga de la pantalla de Carritos) para que la
  // lectura ya no dependa de PrestaShop en absoluto.
  const productIds = [...new Set(cartsWithRawItems.flatMap(x => x.items.map(i => i.id_product)))].filter(Boolean);
  const productById = {};
  if (productIds.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const chunk = productIds.slice(i, i + CHUNK);
      const filterVal = encodeURIComponent(`[${chunk.join('|')}]`);
      const fields = '[id,name,reference,price,id_default_image]';
      const pdata = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/products?display=${encodeURIComponent(fields)}&filter[id]=${filterVal}&limit=0,${chunk.length}`);
      (pdata.products || []).forEach(p => {
        const imgId = p.id_default_image;
        productById[p.id] = {
          name: firstLangValue(p.name, `Producto #${p.id}`),
          sku: p.reference || `PS-${p.id}`,
          price: parseFloat(p.price || 0),
          img: imgId && imgId !== '0' ? `${ctx.baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${ctx.apiKey}` : ''
        };
      });
    }
  }

  const rows = cartsWithRawItems.map(({ cart: c, items }) => {
    const cust = custById[c.id_customer];
    const enrichedItems = items.map(it => {
      const prod = productById[it.id_product] || {};
      return {
        id_product: it.id_product, qty: it.qty,
        name: prod.name || `Producto #${it.id_product}`, sku: prod.sku || '',
        price: prod.price || 0, img: prod.img || ''
      };
    });
    return {
      id: Number(c.id), id_customer: Number(c.id_customer) || null,
      customer_name: cust?.name || `Invitado #${c.id}`, customer_email: cust?.email || null,
      items: enrichedItems, order_reference: orderByCart[c.id] || null,
      date_add: c.date_add || null, date_upd: c.date_upd || null
    };
  });

  await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_carritos', rows, 'id');
  return rows.length;
}

// ================= STOCK (paginado con cursor retomable) =================
// Con ~82,000 filas, una sola corrida de ~50s no siempre alcanza a barrer
// toda la tabla (confirmado: se quedaba en la fila ~67,000 de 82,000). Antes
// cada corrida reiniciaba la paginación desde cero, así que los productos
// "de hasta atrás" nunca llegaban a refrescarse — se quedaban con el stock
// del primer sync (17 de septiembre) para siempre, aunque el resto de la
// tabla sí se mantuviera al día.
//
// Ahora se guarda en ps_sync_estado dónde se quedó cada corrida (el id
// interno de PrestaShop del registro de stock, no el id de producto) y la
// siguiente corrida retoma justo ahí en vez de reiniciar. Al llegar al
// final real de la tabla, el cursor vuelve a 0 y empieza un ciclo nuevo —
// así, en varias corridas seguidas, TODA la tabla queda cubierta de forma
// rotativa, en vez de repetir siempre el mismo primer tramo.
async function syncStock(ctx) {
  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'stock');
  let sinceId = state && state.last_synced_id ? Number(state.last_synced_id) : 0;
  const MAX_ID = 999999999;

  const PAGE_SIZE = 1000;
  const UPLOAD_EVERY = 10;
  let pagesSinceFlush = 0, total = 0;
  const startedAt = Date.now();
  let pending = [];
  let lastSeenId = sinceId;
  let reachedEnd = false;

  async function flush() {
    if (pending.length === 0) return;
    // PrestaShop puede traer más de una fila de stock para el mismo
    // producto+almacén (ej. por combinaciones/atributos) — se suman antes
    // de subir, porque un upsert con la misma llave repetida en el mismo
    // lote truena ("ON CONFLICT DO UPDATE command cannot affect row a
    // second time").
    const dedup = {};
    pending.forEach(r => {
      const key = `${r.id_product}|${r.id_warehouse}`;
      if (!dedup[key]) dedup[key] = { ...r };
      else dedup[key].quantity += r.quantity;
    });
    const dedupedRows = Object.values(dedup);
    await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_stock', dedupedRows, 'id_product,id_warehouse');
    total += dedupedRows.length;
    pending = [];
    pagesSinceFlush = 0;
  }

  while (Date.now() - startedAt < ctx.timeBudgetMs) {
    const rangeFilter = encodeURIComponent(`[${sinceId + 1},${MAX_ID}]`);
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/stocks?display=[id,id_product,id_warehouse,usable_quantity]&filter[id]=${rangeFilter}&sort=[id_ASC]&limit=0,${PAGE_SIZE}`);
    const batch = data.stocks || [];
    if (batch.length === 0) { reachedEnd = true; break; }
    batch.forEach(s => {
      pending.push({ id_product: Number(s.id_product), id_warehouse: Number(s.id_warehouse), quantity: Math.round(parseFloat(s.usable_quantity || 0)) });
      lastSeenId = Math.max(lastSeenId, Number(s.id));
    });
    sinceId = lastSeenId; // avanza el cursor para la siguiente página dentro de esta misma corrida
    pagesSinceFlush++;
    if (pagesSinceFlush >= UPLOAD_EVERY) await flush();
    if (batch.length < PAGE_SIZE) { reachedEnd = true; break; }
  }
  await flush();

  // Si se llegó al final real de la tabla, la siguiente corrida empieza un
  // ciclo nuevo desde 0; si se acabó el tiempo a la mitad, retoma justo
  // donde se quedó.
  const nextCursor = reachedEnd ? 0 : lastSeenId;
  await sbSetSyncState(
    ctx.supabaseUrl, ctx.serviceKey, 'stock', nextCursor,
    reachedEnd ? `ciclo completo (${total} filas)` : `parcial, retoma en id>${nextCursor} (${total} filas)`
  );
  return total;
}

// ================= MOVIMIENTOS DE INVENTARIO (histórico, cursor retomable) =================
// Traslada el historial completo de stock_mvt de PrestaShop a Supabase
// (ps_inventory_movements) — mismo mecanismo de cursor retomable que
// syncStock, porque el volumen histórico no cabe en una sola corrida
// serverless. La tabla ya existía (creada por otra sesión que trabaja en
// paralelo sobre este repo, ver docs/prestashop-inventory-history-setup.sql
// en la rama codex/complete-prestashop-migration — no mergeada a main) y
// ya tenía 5,455 filas cargadas a mano, documentadas ahí mismo como
// "pendiente de carga". Se guarda con el mismo shape que esas filas
// existentes (id + data jsonb = objeto completo de PrestaShop) para no
// romper la lectura ya construida sobre esa tabla. No se toca
// pos_stock_moves (el ledger interno del POS) — un movimiento histórico
// importado no debe volver a alterar el stock actual, ya está reflejado en
// el stock ya sincronizado.
async function syncMovimientos(ctx) {
  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'movimientos');
  let sinceId = state && state.last_synced_id ? Number(state.last_synced_id) : 0;
  const MAX_ID = 999999999;

  // El recurso PrestaShop se llama "stock_movements" en la URL pero la
  // clave real del JSON de vuelta es "stock_mvts" (nombre interno de la
  // tabla) — confirmado con un log real; con la clave equivocada el batch
  // siempre salía vacío y el sync se marcaba "completo" sin traer nada.
  //
  // Filtrar por almacén es obligatorio, no opcional: sin filtro, un id
  // bajo (probado con id=1) devuelve movimientos con id_warehouse=32, que
  // NO existe en ps_almacenes (las bodegas reales de Mi Fiestashop son
  // 53–58) — el mismo tipo de contaminación entre tiendas que ya está
  // documentada como problema pendiente de limpieza para "addresses" en la
  // otra rama de migración. PERO filter[id_warehouse] en la API de
  // PrestaShop no funciona en este recurso — probado con varias variantes
  // (con/sin corchetes, un solo valor, combinado con filter[id]): TODAS
  // devuelven [] vacío, incluso para la bodega 53 que sí tiene datos
  // reales. id_warehouse simplemente no es un campo filtrable en
  // stock_movements para esta instalación. Se filtra por almacén acá, en
  // el código, después de traer por rango de id (que sí funciona).
  const almacenesRes = await fetch(`${ctx.supabaseUrl}/rest/v1/ps_almacenes?select=id`, {
    headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` }
  });
  const almacenes = await almacenesRes.json();
  const warehouseIds = (Array.isArray(almacenes) ? almacenes : []).map(a => a.id);
  if (warehouseIds.length === 0) throw new Error('ps_almacenes vacío: no se puede acotar el sync de movimientos a las bodegas reales');

  const PAGE_SIZE = 1000;
  const UPLOAD_EVERY = 5;
  let pagesSinceFlush = 0, total = 0, skipped = 0;
  const startedAt = Date.now();
  let pending = [];
  let lastSeenId = sinceId;
  let reachedEnd = false;

  // ps_inventory_movements tiene RLS que solo permite escribir con la
  // llave de servicio real de Supabase (revocado explícitamente para
  // anon/authenticated en su setup — es una tabla privada a propósito).
  // Confirmado en vivo: con la llave anon (la que usa el resto de este
  // archivo) el upsert falla con 401 "permission denied".
  if (!ctx.serviceRoleKey) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: ps_inventory_movements requiere la llave de servicio, no la anon');

  async function flush() {
    if (pending.length === 0) return;
    await sbUpsert(ctx.supabaseUrl, ctx.serviceRoleKey, 'ps_inventory_movements', pending, 'id');
    total += pending.length;
    pending = [];
    pagesSinceFlush = 0;
  }

  while (Date.now() - startedAt < ctx.timeBudgetMs) {
    const rangeFilter = encodeURIComponent(`[${sinceId + 1},${MAX_ID}]`);
    const path = `/api/stock_movements?display=full&filter[id]=${rangeFilter}&sort=[id_ASC]&limit=0,${PAGE_SIZE}`;
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, path);
    const batch = data.stock_mvts || [];
    if (batch.length === 0) { reachedEnd = true; break; }
    batch.forEach(m => {
      // id siempre avanza el cursor (incluso si se descarta por bodega),
      // para no reprocesar por siempre los mismos ids de otras tiendas.
      lastSeenId = Math.max(lastSeenId, Number(m.id));
      if (warehouseIds.includes(Number(m.id_warehouse))) {
        pending.push({ id: Number(m.id), data: m });
      } else {
        skipped++;
      }
    });
    sinceId = lastSeenId;
    pagesSinceFlush++;
    if (pagesSinceFlush >= UPLOAD_EVERY) await flush();
    if (batch.length < PAGE_SIZE) { reachedEnd = true; break; }
  }
  await flush();

  const nextCursor = reachedEnd ? 0 : lastSeenId;
  await sbSetSyncState(
    ctx.supabaseUrl, ctx.serviceKey, 'movimientos', nextCursor,
    reachedEnd ? `ciclo completo (${total} filas, ${skipped} de otra tienda descartadas)` : `parcial, retoma en id>${nextCursor} (${total} filas, ${skipped} descartadas)`
  );
  return total;
}

// ================= MOVIMIENTOS RECIENTES (los últimos N de Mi Fiestashop) =================
// Para cuando importa lo más nuevo primero, no el histórico completo desde
// el id 1 — recorre de MÁS NUEVO a MÁS VIEJO (sort=[id_DESC]) y se detiene
// cuando junta N movimientos de bodegas reales de Mi Fiestashop (el
// recorrido histórico de arriba es ascendente y sigue su propio cursor,
// ps_sync_estado 'movimientos'; este usa 'movimientos_recientes' y no
// interfiere con él). Como solo ~4% de los ids crudos son de esta tienda
// (el resto son de otras tiendas en la misma instalación de PrestaShop,
// se descartan), juntar N=10,000 requiere revisar del orden de 250,000 ids
// crudos — varias corridas; el cursor (el id más bajo alcanzado) y el
// conteo acumulado se guardan entre corridas para retomar sin repetir.
//
// ultimo_resultado guarda "recientes;collected=N;target=T" para poder
// retomar el conteo acumulado (last_synced_id solo guarda el cursor).
async function syncMovimientosRecientes(ctx) {
  const target = Number.isFinite(ctx.recentTarget) && ctx.recentTarget > 0 ? ctx.recentTarget : 10000;
  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'movimientos_recientes');
  const prevMatch = state && typeof state.ultimo_resultado === 'string' ? state.ultimo_resultado.match(/^recientes;collected=(\d+);target=(\d+)/) : null;
  // Si cambió el objetivo (target) desde la última corrida, se empieza de
  // cero en vez de mezclar conteos de objetivos distintos.
  const sameTarget = prevMatch && Number(prevMatch[2]) === target;
  let collected = sameTarget ? Number(prevMatch[1]) : 0;
  let cursor = sameTarget && state.last_synced_id ? Number(state.last_synced_id) : 0; // 0 = empezar desde el tope real

  if (collected >= target) return 0;

  const almacenesRes = await fetch(`${ctx.supabaseUrl}/rest/v1/ps_almacenes?select=id`, {
    headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` }
  });
  const almacenes = await almacenesRes.json();
  const warehouseIds = (Array.isArray(almacenes) ? almacenes : []).map(a => a.id);
  if (warehouseIds.length === 0) throw new Error('ps_almacenes vacío: no se puede acotar a las bodegas reales');
  if (!ctx.serviceRoleKey) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: ps_inventory_movements requiere la llave de servicio, no la anon');

  // Tope real de PrestaShop (el id más alto que existe hoy) — solo la
  // primera vez; después el cursor ya lo lleva.
  let upper = cursor;
  if (!upper) {
    const top = await psFetch(ctx.baseUrl, ctx.apiKey, '/api/stock_movements?display=[id]&sort=[id_DESC]&limit=0,1');
    const topRow = (top.stock_mvts || [])[0];
    if (!topRow) throw new Error('No se pudo obtener el id más alto de stock_movements');
    upper = Number(topRow.id);
  }

  const PAGE_SIZE = 1000;
  const UPLOAD_EVERY = 5;
  let pagesSinceFlush = 0, added = 0, skipped = 0, reachedBottom = false;
  const startedAt = Date.now();
  let pending = [];
  let lowestSeen = upper + 1;

  async function flush() {
    if (pending.length === 0) return;
    await sbUpsert(ctx.supabaseUrl, ctx.serviceRoleKey, 'ps_inventory_movements', pending, 'id');
    added += pending.length;
    pending = [];
    pagesSinceFlush = 0;
  }

  while (Date.now() - startedAt < ctx.timeBudgetMs && collected + added + pending.length < target) {
    const rangeFilter = encodeURIComponent(`[1,${upper}]`);
    const path = `/api/stock_movements?display=full&filter[id]=${rangeFilter}&sort=[id_DESC]&limit=0,${PAGE_SIZE}`;
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, path);
    const batch = data.stock_mvts || [];
    if (batch.length === 0) { reachedBottom = true; break; }
    for (const m of batch) {
      lowestSeen = Math.min(lowestSeen, Number(m.id));
      if (warehouseIds.includes(Number(m.id_warehouse))) {
        if (collected + added + pending.length < target) pending.push({ id: Number(m.id), data: m });
      } else {
        skipped++;
      }
    }
    upper = lowestSeen - 1;
    pagesSinceFlush++;
    if (pagesSinceFlush >= UPLOAD_EVERY) await flush();
    if (batch.length < PAGE_SIZE) { reachedBottom = true; break; }
  }
  await flush();

  collected += added;
  const done = collected >= target || reachedBottom;
  await sbSetSyncState(
    ctx.supabaseUrl, ctx.serviceKey, 'movimientos_recientes', done ? lowestSeen : upper,
    `recientes;collected=${collected};target=${target}` + (done ? ';completo' : ';parcial') + ` (${added} esta corrida, ${skipped} descartadas)`
  );
  return added;
}

// ================= MOVIMIENTOS DESDE UNA FECHA =================
// Igual que movimientos_recientes (de más nuevo a más viejo, filtrando por
// bodega real en el código) pero se detiene por FECHA (date_add >= since)
// en vez de por cantidad. Si ya existe el cursor de movimientos_recientes,
// arranca desde ahí (con un traslape de una página, el upsert es
// idempotente) para no volver a revisar lo ya traído.
async function syncMovimientosDesde(ctx) {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.recentSince || '')) ? ctx.recentSince : null;
  if (!since) throw new Error('Falta recentSince=YYYY-MM-DD');
  const sinceTs = `${since} 00:00:00`;

  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'movimientos_desde');
  const prev = state && typeof state.ultimo_resultado === 'string' ? state.ultimo_resultado.match(/^desde=(\S+);collected=(\d+);(parcial|completo)/) : null;
  const sameSince = prev && prev[1] === since;
  if (sameSince && prev[3] === 'completo') return 0;
  let collected = sameSince ? Number(prev[2]) : 0;
  let upper = sameSince && state.last_synced_id ? Number(state.last_synced_id) : 0;
  if (!upper) {
    const rec = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'movimientos_recientes');
    if (rec && rec.last_synced_id) upper = Number(rec.last_synced_id) + 1000;
  }

  const almacenesRes = await fetch(`${ctx.supabaseUrl}/rest/v1/ps_almacenes?select=id`, {
    headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` }
  });
  const almacenes = await almacenesRes.json();
  const warehouseIds = (Array.isArray(almacenes) ? almacenes : []).map(a => a.id);
  if (warehouseIds.length === 0) throw new Error('ps_almacenes vacío: no se puede acotar a las bodegas reales');
  if (!ctx.serviceRoleKey) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: ps_inventory_movements requiere la llave de servicio, no la anon');

  if (!upper) {
    const top = await psFetch(ctx.baseUrl, ctx.apiKey, '/api/stock_movements?display=[id]&sort=[id_DESC]&limit=0,1');
    const topRow = (top.stock_mvts || [])[0];
    if (!topRow) throw new Error('No se pudo obtener el id más alto de stock_movements');
    upper = Number(topRow.id);
  }

  const PAGE_SIZE = 1000;
  const UPLOAD_EVERY = 5;
  let pagesSinceFlush = 0, added = 0, skipped = 0, reachedBoundary = false;
  const startedAt = Date.now();
  let pending = [];
  let lowestSeen = upper + 1;

  async function flush() {
    if (pending.length === 0) return;
    await sbUpsert(ctx.supabaseUrl, ctx.serviceRoleKey, 'ps_inventory_movements', pending, 'id');
    added += pending.length;
    pending = [];
    pagesSinceFlush = 0;
  }

  while (Date.now() - startedAt < ctx.timeBudgetMs) {
    const rangeFilter = encodeURIComponent(`[1,${upper}]`);
    const path = `/api/stock_movements?display=full&filter[id]=${rangeFilter}&sort=[id_DESC]&limit=0,${PAGE_SIZE}`;
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, path);
    const batch = data.stock_mvts || [];
    if (batch.length === 0) { reachedBoundary = true; break; }
    let newestInPage = '';
    for (const m of batch) {
      lowestSeen = Math.min(lowestSeen, Number(m.id));
      const d = String(m.date_add || '');
      if (d > newestInPage) newestInPage = d;
      if (warehouseIds.includes(Number(m.id_warehouse)) && d >= sinceTs) pending.push({ id: Number(m.id), data: m });
      else skipped++;
    }
    upper = lowestSeen - 1;
    pagesSinceFlush++;
    if (pagesSinceFlush >= UPLOAD_EVERY) await flush();
    // Página completa más vieja que la fecha pedida: ya se pasó el límite.
    if (newestInPage && newestInPage < sinceTs) { reachedBoundary = true; break; }
    if (batch.length < PAGE_SIZE) { reachedBoundary = true; break; }
  }
  await flush();

  collected += added;
  await sbSetSyncState(
    ctx.supabaseUrl, ctx.serviceKey, 'movimientos_desde', upper,
    `desde=${since};collected=${collected};${reachedBoundary ? 'completo' : 'parcial'} (${added} esta corrida, ${skipped} descartadas)`
  );
  return added;
}

// Orden con las bodegas/catálogos chicos primero (categorias/almacenes/
// empleados — pedidos necesita que empleados ya esté sincronizado para
// resolver nombres de cajero), luego stock (el dominio más pesado — más de
// 80,000 filas — y el que se estaba quedando siempre sin tiempo al ir al
// final) antes que clientes/pedidos/carritos. "movimientos" y
// "movimientos_recientes" van al final y aparte: son históricos de una
// sola vez (no cambian hora con hora como el resto), así que solo corren
// cuando se piden explícito (?domain=movimientos / ?domain=movimientos_
// recientes), nunca en el cron automático — los dos crons ya enumeran sus
// dominios explícitamente en vercel.json, sin incluirlos.
const DOMAIN_ORDER = ['categorias', 'almacenes', 'empleados', 'stock', 'clientes', 'pedidos', 'carritos', 'movimientos', 'movimientos_recientes', 'movimientos_desde'];

async function runFullSync({ baseUrl, apiKey, supabaseUrl, serviceKey, serviceRoleKey, timeBudgetMs = 45000, domains, recentTarget, recentSince }) {
  // timeBudgetMs es el presupuesto TOTAL de toda la corrida, no por dominio
  // — antes cada dominio recibía su propio presupuesto completo sin
  // importar cuánto ya habían tardado los anteriores, así que si categorías
  // + almacenes + empleados + clientes + pedidos + carritos ya se habían
  // tardado varios segundos, a "stock" (el más pesado, ~45s él solo) ya no
  // le alcanzaba el tiempo que le quedaba a la función serverless completa
  // (maxDuration) y la corrida se cortaba a la mitad de su paginación sin
  // haber subido nada todavía — por eso el stock sincronizado se quedó
  // parado por más de un día mientras clientes/pedidos/carritos sí seguían
  // actualizándose con normalidad.
  const deadline = Date.now() + timeBudgetMs;
  const ctx = { baseUrl, apiKey, supabaseUrl, serviceKey, serviceRoleKey, timeBudgetMs, recentTarget, recentSince };
  const all = { categorias: syncCategorias, almacenes: syncAlmacenes, empleados: syncEmpleados, clientes: syncClientes, pedidos: syncPedidos, carritos: syncCarritos, stock: syncStock, movimientos: syncMovimientos, movimientos_recientes: syncMovimientosRecientes, movimientos_desde: syncMovimientosDesde };
  const requested = domains && domains.length ? domains : DOMAIN_ORDER;
  const toRun = DOMAIN_ORDER.filter(d => requested.includes(d));

  const results = {};
  for (const name of toRun) {
    const startedAt = Date.now();
    const remaining = deadline - startedAt;
    if (remaining < 3000) {
      results[name] = { ok: false, skipped: true, error: 'sin tiempo suficiente en esta corrida', ms: 0 };
      continue;
    }
    ctx.timeBudgetMs = remaining;
    try {
      const count = await all[name](ctx);
      results[name] = { ok: true, count, ms: Date.now() - startedAt };
    } catch (e) {
      results[name] = { ok: false, error: e.message, ms: Date.now() - startedAt };
    }
  }
  return results;
}

module.exports = { runFullSync };
