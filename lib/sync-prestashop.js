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
const { normalizeAddress } = require('./customer-addresses');

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
  const r = await fetch(url, { headers: psHeaders(apiKey), signal: AbortSignal.timeout(30000) });
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
  if (!r.ok) throw new Error(`Estado de sincronización: HTTP ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function sbSetSyncState(supabaseUrl, serviceKey, dominio, lastId, resultado) {
  const response = await fetch(`${supabaseUrl}/rest/v1/ps_sync_estado?on_conflict=dominio`, {
    method: 'POST',
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ dominio, last_synced_id: lastId, last_synced_at: new Date().toISOString(), ultimo_resultado: resultado })
  });
  if (!response.ok) throw new Error(`Guardar cursor: HTTP ${response.status}`);
}

// Refresh complete resources in durable ID-ordered pages. A completed cycle
// resets its cursor so later edits/deletions are revisited on the next cycle.
async function syncResource(ctx, domain, resource, table, transform, extraQuery = '') {
  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, domain);
  let cursor = Number(state?.last_synced_id || 0), count = 0;
  const generation = cursor && state?.ultimo_resultado?.startsWith('cycle:')
    ? state.ultimo_resultado.slice(6) : require('node:crypto').randomUUID();
  // Cursor and generation are persisted together before any data is written.
  if (cursor && !state?.ultimo_resultado?.startsWith('cycle:')) cursor = 0;
  await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, domain, cursor, `cycle:${generation}`);
  const started = Date.now();
  while (Date.now() - started < ctx.timeBudgetMs) {
    const range = encodeURIComponent(`[${cursor + 1},999999999]`);
    const data = await psFetch(ctx.baseUrl, ctx.apiKey,
      `/api/${resource}?id_shop=50&display=full&sort=[id_ASC]&filter[id]=${range}&limit=0,250${extraQuery}`);
    const batch = data[resource];
    if (!Array.isArray(batch)) {
      // PrestaShop represents an empty collection as [] at the top level too.
      if (!Array.isArray(data) || data.length) throw new Error(`Respuesta inválida: ${resource}`);
    }
    const items = batch || [];
    if (!items.length) {
      // Only remove stale source records after a complete traversal. Failed or
      // timed-out pages never erase the previously imported snapshot.
      const stale = await fetch(`${ctx.supabaseUrl}/rest/v1/${table}?generation=neq.${generation}`, {
        method: 'DELETE', headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` }
      });
      if (!stale.ok) throw new Error(`Conciliación ${table}: HTTP ${stale.status}`);
      await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, domain, 0, `completo; última ejecución ${count}`);
      return { count, complete: true };
    }
    for (const item of items) {
      if (!Number.isSafeInteger(Number(item.id)) || Number(item.id) <= cursor) throw new Error(`Paginación sin avance: ${resource}`);
    }
    const rows = items.map(transform).filter(Boolean).map(row => ({ ...row, generation }));
    await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, table, rows, 'id');
    cursor = Math.max(...items.map(row => Number(row.id)));
    count += rows.length;
    await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, domain, cursor, `cycle:${generation}`);
  }
  return { count, complete: false, cursor };
}

async function syncDirecciones(ctx) {
  // Addresses are global in this multishop installation. The API key's shop
  // context alone does not isolate them: intersect with our customer directory.
  const customers = new Set();
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${ctx.supabaseUrl}/rest/v1/ps_clientes?select=id&order=id.asc`, {
      headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}`, Range: `${offset}-${offset+999}` }
    });
    if (!response.ok) throw new Error(`Clientes para direcciones: HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Directorio de clientes inválido');
    rows.forEach(row => customers.add(Number(row.id)));
    if (rows.length < 1000) break;
  }
  if (!customers.size) throw new Error('Importa primero los clientes de Mi Fiestashop');
  const ids = [...customers];
  const range = encodeURIComponent(`[${Math.min(...ids)},${Math.max(...ids)}]`);
  return syncResource(ctx, 'direcciones', 'addresses', 'ps_direcciones',
    row => customers.has(Number(row.id_customer)) ? normalizeAddress(row) : null,
    `&filter[id_customer]=${range}`);
}
const snapshot = row => ({ id: Number(row.id), data: row, synced_at: new Date().toISOString() });
const syncProductos = ctx => syncResource(ctx, 'productos', 'products', 'ps_productos_comercio', snapshot);
const syncPrecios = ctx => syncResource(ctx, 'precios', 'specific_prices', 'ps_precios_especificos', snapshot);
const syncDisponibilidad = ctx => syncResource(ctx, 'disponibilidad', 'stock_availables', 'ps_disponibilidad', snapshot);

// ================= CATEGORÍAS =================
async function syncCategorias(ctx) {
  const data = await psFetch(ctx.baseUrl, ctx.apiKey, '/api/categories?display=[id,name,id_parent,active]&limit=0,1000');
  const rows = (data.categories || []).map(c => ({
    id: Number(c.id), name: firstLangValue(c.name, `Categoría ${c.id}`),
    id_parent: c.id_parent ? Number(c.id_parent) : null, active: c.active === '1' || c.active === 1
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
        // Address fields are imported separately; never erase an existing value
        // when replaying a customer page or restarting the initial migration.
        email: c.email || null,
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
async function syncPedidos(ctx, rawBatch) {
  const fields = '[id,reference,id_customer,current_state,date_add,date_upd,delivery_date,id_shop,id_employee,payment,total_paid,valid,note,id_carrier,total_products,total_discounts,total_shipping,invoice_number,invoice_date,id_cart]';
  const data = rawBatch ? { orders: rawBatch } : await psFetch(ctx.baseUrl, ctx.apiKey, `/api/orders?display=${encodeURIComponent(fields)}&sort=[id_DESC]&limit=0,${PS_ORDERS_WINDOW}`);
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
    for (let offset = 0; ; offset += 500) {
    const ddata = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/order_details?display=${encodeURIComponent(detailFields)}&filter[id_order]=${filterVal}&sort=[id_ASC]&limit=${offset},500`);
    const details = ddata.order_details || [];
    details.forEach(row => {
      const oid = row.id_order;
      if (!itemsByOrder[oid]) itemsByOrder[oid] = [];
      itemsByOrder[oid].push({
        product_id: Number(row.product_id), name: row.product_name || '', sku: row.product_reference || '',
        qty: parseFloat(row.product_quantity || 0), price: parseFloat(row.product_price || 0)
      });
    });
    if (details.length < 500) break;
    }
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
  if (!rawBatch) await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'pedidos', rows[0]?.id || 0, `ventana de ${rows.length}`);
  return rows.length;
}

async function syncPedidosHistoricos(ctx) {
  const state = await sbGetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'pedidos_historicos');
  let cursor = Number(state?.last_synced_id || 0), count = 0;
  const started = Date.now();
  while (Date.now() - started < ctx.timeBudgetMs) {
    const filter = encodeURIComponent(`[${cursor + 1},999999999]`);
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/orders?display=full&sort=[id_ASC]&filter[id]=${filter}&limit=0,100`);
    if (!Array.isArray(data.orders) && !(Array.isArray(data) && data.length === 0)) throw new Error('Respuesta inválida: orders');
    const batch = data.orders || [];
    if (!batch.length) {
      await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'pedidos_historicos', cursor, 'completo');
      return { count, complete: true, cursor };
    }
    if (batch.some(o => Number(o.id) <= cursor)) throw new Error('Paginación de pedidos sin avance');
    count += await syncPedidos(ctx, batch);
    cursor = Math.max(...batch.map(o => Number(o.id)));
    await sbSetSyncState(ctx.supabaseUrl, ctx.serviceKey, 'pedidos_historicos', cursor, 'en curso');
  }
  return { count, complete: false, cursor };
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

  const cartsWithRawItems = [];
  for (const c of rawCarts) {
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

// ================= STOCK (completo, paginado con presupuesto de tiempo) =================
async function syncStock(ctx) {
  const PAGE_SIZE = 1000;
  let page = 0, total = 0;
  const startedAt = Date.now();
  const rows = [];
  while (Date.now() - startedAt < ctx.timeBudgetMs) {
    const data = await psFetch(ctx.baseUrl, ctx.apiKey, `/api/stocks?display=[id_product,id_warehouse,usable_quantity]&limit=${page * PAGE_SIZE},${PAGE_SIZE}`);
    const batch = data.stocks || [];
    if (batch.length === 0) break;
    batch.forEach(s => {
      rows.push({ id_product: Number(s.id_product), id_warehouse: Number(s.id_warehouse), quantity: Math.round(parseFloat(s.usable_quantity || 0)) });
    });
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  // PrestaShop puede traer más de una fila de stock para el mismo
  // producto+almacén (ej. por combinaciones/atributos) — se suman antes de
  // subir, porque un upsert con la misma llave repetida en el mismo lote
  // truena ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const dedup = {};
  rows.forEach(r => {
    const key = `${r.id_product}|${r.id_warehouse}`;
    if (!dedup[key]) dedup[key] = { ...r };
    else dedup[key].quantity += r.quantity;
  });
  const dedupedRows = Object.values(dedup);

  const CHUNK = 1000;
  for (let i = 0; i < dedupedRows.length; i += CHUNK) {
    await sbUpsert(ctx.supabaseUrl, ctx.serviceKey, 'ps_stock', dedupedRows.slice(i, i + CHUNK), 'id_product,id_warehouse');
    total += dedupedRows.slice(i, i + CHUNK).length;
  }
  return total;
}

async function runFullSync({ baseUrl, apiKey, supabaseUrl, serviceKey, timeBudgetMs = 45000, domains }) {
  const ctx = { baseUrl, apiKey, supabaseUrl, serviceKey, timeBudgetMs };
  const all = { categorias: syncCategorias, almacenes: syncAlmacenes, empleados: syncEmpleados, clientes: syncClientes, pedidos: syncPedidos, carritos: syncCarritos, stock: syncStock,
    direcciones: syncDirecciones, productos: syncProductos, precios: syncPrecios, disponibilidad: syncDisponibilidad, pedidos_historicos: syncPedidosHistoricos };
  // The full backfill is explicit: it must run outside a short serverless request.
  const toRun = domains && domains.length ? domains : ['categorias', 'almacenes', 'empleados', 'clientes', 'pedidos', 'carritos', 'stock'];

  const results = {};
  for (const name of toRun) {
    const startedAt = Date.now();
    try {
      if (!Object.hasOwn(all, name)) throw new Error('Dominio de sincronización inválido');
      const result = await all[name](ctx);
      results[name] = { ok: true, ...(typeof result === 'object' ? result : { count: result }), ms: Date.now() - startedAt };
    } catch (e) {
      results[name] = { ok: false, error: e.message, ms: Date.now() - startedAt };
    }
  }
  return results;
}

module.exports = { runFullSync };
