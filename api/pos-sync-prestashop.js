// Vercel serverless function: cuando se cierra un ticket en el Sistema POS,
// esto crea el pedido correspondiente EN PRESTASHOP (carrito -> pedido ->
// líneas de pedido) y descuenta su propio stock — hasta ahora el POS solo
// afectaba el ledger propio de Supabase (pos_stock_moves) y PrestaShop
// nunca se enteraba de la venta.
//
// Es la primera vez que esta app ESCRIBE hacia PrestaShop (todo lo demás
// solo lee). Se diseñó para no bloquear nunca la venta del POS: el ticket y
// el descuento en Supabase siempre se guardan primero (ver confirmPOSSale en
// index.html); esto se llama después, best-effort, y el resultado
// (sincronizado/error) se guarda en pos_tickets.ps_sync_status para poder
// ver y reintentar los que fallen, en vez de fallar en silencio.
//
// POST body: {
//   p_admin_password, p_staff_email, p_staff_pin,  // sesión (ver getSessionCredsParams)
//   folio, almacen: 'puebla'|'rumania'|'queretaro'|'atizapan',
//   items: [{ id, name, qty, price }],  // price = precio unitario CON IVA si aplica
//   subtotal, iva, total, paymentMethod
// }
// -> { ok: true, ps_order_id } | { ok: false, error, detail }
//
// Requiere PS_BASE_URL, PS_API_KEY (mismos que el resto de /api).

const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// Cliente y dirección genéricos "Cliente POS" ya usados por el resto del
// negocio para ventas de mostrador sin factura — confirmados a mano en
// PrestaShop antes de escribir este archivo.
const POS_CUSTOMER_ID = 101973;
const POS_ADDRESS_ID = 166996;
const CARRIER_ID = 1; // Recolección en tienda / envío no aplica a venta de mostrador
const ORDER_STATE_PAID = 2; // "Pago aceptado"
const SHOP_ID = 50; // única tienda de PrestaShop para todas las sucursales
const PAYMENT_MODULE = 'ps_checkpayment'; // módulo genérico existente, aprobado por el usuario

// Sucursal (como la usa este app) -> empleado de PrestaShop que "atendió" la
// venta, y almacén de PrestaShop para descontar stock.
const BRANCH_TO_EMPLOYEE = { puebla: 230, rumania: 225, queretaro: 226, atizapan: 227 };
const BRANCH_TO_WAREHOUSE = { puebla: 55, rumania: 53, queretaro: 56, atizapan: 58 };

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sbRpcServer(fnName, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!r.ok) throw new Error(`RPC ${fnName} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
    catch (e) { res.status(400).json({ ok: false, error: 'JSON inválido' }); return; }
  } else if (req.method === 'GET' && req.query.payload) {
    // Solo para pruebas manuales desde una herramienta que no puede mandar
    // POST (ver PR de esta función) — el flujo real del POS siempre usa
    // POST. Quitar este bloque antes de dar por cerrada la función.
    try { body = JSON.parse(req.query.payload); }
    catch (e) { res.status(400).json({ ok: false, error: 'payload inválido' }); return; }
  } else {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  // JSON.stringify() omite las claves con valor undefined — si falta una de
  // las 3 (p.ej. solo se manda p_staff_email/p_staff_pin, sin
  // p_admin_password), PostgREST deja de encontrar la función RPC porque
  // rpc_check_session no tiene default para ese parámetro. Normalizarlas a
  // null asegura que las 3 siempre viajen.
  const p_admin_password = body.p_admin_password ?? null;
  const p_staff_email = body.p_staff_email ?? null;
  const p_staff_pin = body.p_staff_pin ?? null;
  const { folio, almacen, items, subtotal, iva, total } = body;

  if (!folio || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ ok: false, error: 'Faltan folio o items' });
    return;
  }

  // Valida la sesión igual que cualquier otra escritura del POS — esto no
  // es un endpoint público para crear pedidos arbitrarios en PrestaShop.
  let session = false;
  try { session = await sbRpcServer('rpc_check_session', { p_admin_password, p_staff_email, p_staff_pin }); }
  catch (e) { res.status(401).json({ ok: false, error: 'unauthorized', detail: e.message }); return; }
  if (!session) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;
  if (!apiKey) { res.status(200).json({ ok: false, error: 'PS_API_KEY no configurado en Vercel' }); return; }
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  async function psGet(path) {
    const r = await fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}output_format=JSON`, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  async function psWrite(method, path, xmlBody) {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, 'Content-Type': 'text/xml' },
      body: xmlBody
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 600)}`);
    return text;
  }

  function xmlTagVal(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([^<\\]]*)`));
    return m ? m[1] : null;
  }

  // Introspección temporal de solo-lectura para depurar el POST a
  // /api/orders (ver PR de esta función) — quitar una vez que la creación
  // de pedidos quede funcionando de forma confiable.
  if (req.query.introspect) {
    try {
      const r = await fetch(`${baseUrl}/api/${req.query.introspect}?schema=synopsis`, { headers });
      const text = await r.text();
      res.status(200).json({ status: r.status, xml: text.slice(0, 4000) });
    } catch (e) { res.status(200).json({ error: e.message }); }
    return;
  }

  const step = { name: 'inicio' };
  try {
    const almacenKey = BRANCH_TO_WAREHOUSE.hasOwnProperty(almacen) ? almacen : 'rumania';
    const idWarehouse = BRANCH_TO_WAREHOUSE[almacenKey];
    const idEmployee = BRANCH_TO_EMPLOYEE[almacenKey];

    // Datos que dependen de la configuración real de la tienda: se
    // consultan en vivo en vez de asumirlos, para no hornear un id
    // equivocado si algún día cambian.
    step.name = 'datos_base';
    const [customerData, currenciesData, languagesData] = await Promise.all([
      psGet(`/api/customers/${POS_CUSTOMER_ID}`),
      psGet('/api/currencies?filter[active]=1&display=[id,iso_code]&limit=0,20'),
      psGet('/api/languages?filter[active]=1&display=[id,iso_code]&limit=0,20')
    ]);
    const customer = customerData.customer;
    if (!customer) throw new Error(`Cliente POS ${POS_CUSTOMER_ID} no encontrado en PrestaShop`);
    const secureKey = customer.secure_key;
    const idLang = (Array.isArray(languagesData.languages) ? languagesData.languages : [languagesData.languages])
      .filter(Boolean).find(l => l.iso_code === 'es')?.id
      || customer.id_lang || 1;
    const idCurrency = (Array.isArray(currenciesData.currencies) ? currenciesData.currencies : [currenciesData.currencies])
      .filter(Boolean).find(c => c.iso_code === 'MXN')?.id || 1;

    const totalNum = Number(total) || 0;
    const subtotalNum = Number(subtotal) || 0;
    const ivaNum = Number(iva) || 0;

    // 1) Carrito con las líneas de la venta.
    step.name = 'crear_carrito';
    const cartRows = items.map(it => `
        <cart_row>
          <id_product>${esc(it.id)}</id_product>
          <id_product_attribute>0</id_product_attribute>
          <id_address_delivery>${POS_ADDRESS_ID}</id_address_delivery>
          <quantity>${esc(it.qty)}</quantity>
        </cart_row>`).join('');
    const cartXml = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <cart>
    <id_currency>${idCurrency}</id_currency>
    <id_lang>${idLang}</id_lang>
    <id_address_delivery>${POS_ADDRESS_ID}</id_address_delivery>
    <id_address_invoice>${POS_ADDRESS_ID}</id_address_invoice>
    <id_customer>${POS_CUSTOMER_ID}</id_customer>
    <id_guest>0</id_guest>
    <id_shop>${SHOP_ID}</id_shop>
    <secure_key>${esc(secureKey)}</secure_key>
    <recyclable>0</recyclable>
    <gift>0</gift>
    <associations>
      <cart_rows>${cartRows}
      </cart_rows>
    </associations>
  </cart>
</prestashop>`;
    const cartResXml = await psWrite('POST', '/api/carts', cartXml);
    const idCart = xmlTagVal(cartResXml, 'id');
    if (!idCart) throw new Error('No se pudo leer id_cart de la respuesta de PrestaShop: ' + cartResXml.slice(0, 300));

    // 2) Pedido referenciando ese carrito, con sus líneas incluidas como
    // asociación order_rows — confirmado contra el synopsis real de este
    // servidor (?schema=synopsis) que esto va DENTRO del propio POST a
    // /api/orders, no como POSTs separados a /api/order_details.
    step.name = 'crear_pedido';
    const orderRows = items.map(it => `
        <order_row>
          <product_id>${esc(it.id)}</product_id>
          <product_attribute_id>0</product_attribute_id>
          <product_quantity>${esc(it.qty)}</product_quantity>
        </order_row>`).join('');
    const orderXml = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <order>
    <id_address_delivery>${POS_ADDRESS_ID}</id_address_delivery>
    <id_address_invoice>${POS_ADDRESS_ID}</id_address_invoice>
    <id_cart>${idCart}</id_cart>
    <id_currency>${idCurrency}</id_currency>
    <id_lang>${idLang}</id_lang>
    <id_customer>${POS_CUSTOMER_ID}</id_customer>
    <id_carrier>${CARRIER_ID}</id_carrier>
    <current_state>${ORDER_STATE_PAID}</current_state>
    <module>${PAYMENT_MODULE}</module>
    <payment>Venta en sucursal (POS ${esc(almacenKey)})</payment>
    <reference>${esc(folio)}</reference>
    <total_paid>${totalNum.toFixed(2)}</total_paid>
    <total_paid_tax_incl>${totalNum.toFixed(2)}</total_paid_tax_incl>
    <total_paid_tax_excl>${subtotalNum.toFixed(2)}</total_paid_tax_excl>
    <total_paid_real>${totalNum.toFixed(2)}</total_paid_real>
    <total_products>${subtotalNum.toFixed(2)}</total_products>
    <total_products_wt>${(subtotalNum + ivaNum).toFixed(2)}</total_products_wt>
    <conversion_rate>1.000000</conversion_rate>
    <id_shop>${SHOP_ID}</id_shop>
    <id_employee>${idEmployee || ''}</id_employee>
    <secure_key>${esc(secureKey)}</secure_key>
    <valid>1</valid>
    <associations>
      <order_rows>${orderRows}
      </order_rows>
    </associations>
  </order>
</prestashop>`;
    const orderResXml = await psWrite('POST', '/api/orders', orderXml);
    const idOrder = xmlTagVal(orderResXml, 'id');
    if (!idOrder) throw new Error('No se pudo leer id_order de la respuesta de PrestaShop: ' + orderResXml.slice(0, 300));
    const lineErrors = [];

    // 4) Descuenta el stock real de PrestaShop para esa bodega — un pedido
    // creado por webservice no dispara el descuento automático que sí
    // ocurre en un checkout normal.
    step.name = 'descontar_stock';
    const stockErrors = [];
    for (const it of items) {
      try {
        const stockData = await psGet(`/api/stock_availables?filter[id_product]=${it.id}&filter[id_product_attribute]=0&filter[id_shop]=${SHOP_ID}&display=[id,quantity]`);
        const rows = Array.isArray(stockData.stock_availables) ? stockData.stock_availables : [stockData.stock_availables].filter(Boolean);
        const row = rows[0];
        if (!row) { stockErrors.push(`producto ${it.id}: no se encontró stock_available`); continue; }
        const newQty = Math.max(0, Number(row.quantity) - Number(it.qty));
        const putXml = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <stock_available>
    <id>${row.id}</id>
    <id_product>${esc(it.id)}</id_product>
    <id_product_attribute>0</id_product_attribute>
    <id_shop>${SHOP_ID}</id_shop>
    <quantity>${newQty}</quantity>
  </stock_available>
</prestashop>`;
        await psWrite('PUT', `/api/stock_availables/${row.id}`, putXml);
      } catch (e) { stockErrors.push(`producto ${it.id}: ${e.message}`); }
    }

    const warnings = [...lineErrors, ...stockErrors];
    await sbRpcServer('rpc_pos_ticket_mark_sync', {
      p_admin_password, p_staff_email, p_staff_pin,
      p_folio: folio, p_status: warnings.length ? 'error' : 'sincronizado',
      p_ps_order_id: parseInt(idOrder, 10), p_error: warnings.length ? warnings.join(' | ').slice(0, 500) : null
    });

    res.status(200).json({ ok: warnings.length === 0, ps_order_id: parseInt(idOrder, 10), warnings });
  } catch (err) {
    try {
      await sbRpcServer('rpc_pos_ticket_mark_sync', {
        p_admin_password, p_staff_email, p_staff_pin,
        p_folio: folio, p_status: 'error', p_ps_order_id: null,
        p_error: `[${step.name}] ${err.message}`.slice(0, 500)
      });
    } catch (e2) { /* si esto también falla, el estado se queda en "pendiente" */ }
    res.status(200).json({ ok: false, error: step.name, detail: err.message });
  }
};
