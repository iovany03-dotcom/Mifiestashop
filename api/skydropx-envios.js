// Vercel serverless function: saldo y guías reales de Skydropx Pro, solo para
// el back office (sesión de admin/personal, igual que api/pedido-admin.js) —
// crear una guía cobra del saldo de la cuenta, por eso no es público.
//
// POST { p_admin_password, p_staff_email, p_staff_pin, accion, ... }
//   accion "saldo"   -> { balance, currency }                (GET /api/v1/finance/credits)
//   accion "crear"   -> { shipment } con guía, rastreo y costo (POST /api/v1/shipments)
//        { quotation_id, rate_id, origen, destino, paquete, carta_porte?, tipo_paquete?, formato? }
//        origen/destino: { nombre, empresa, telefono, email, calle, referencia? }
//        (estado/municipio/colonia/CP se heredan de la cotización)
//   accion "listar"  -> { shipments } últimos envíos de la cuenta (GET /api/v1/shipments)
//   accion "detalle" -> { shipment }                         (GET /api/v1/shipments/:id)
//
// Env vars: SKYDROPX_API_KEY, SKYDROPX_API_SECRET, SKYDROPX_BASE_URL (opcional).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// Valores de ejemplo de la documentación de Skydropx; se pueden cambiar con
// variables de entorno o por solicitud (la clave de Carta Porte debe ser la
// que corresponda a lo que se envía).
const DEFAULT_CONSIGNMENT_NOTE = process.env.SKYDROPX_CONSIGNMENT_NOTE || '53102400';
const DEFAULT_PACKAGE_TYPE = process.env.SKYDROPX_PACKAGE_TYPE || '4G';

async function checkSession(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_check_session`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_admin_password: body.p_admin_password ?? null, p_staff_email: body.p_staff_email ?? null, p_staff_pin: body.p_staff_pin ?? null
    })
  });
  if (!r.ok) return false;
  return !!(await r.json());
}

async function getAccessToken(baseUrl, clientId, clientSecret) {
  const attempts = [
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString() },
    { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) }
  ];
  let lastError = null;
  for (const a of attempts) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/oauth/token`, { method: 'POST', headers: a.headers, body: a.body });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        lastError = new Error(`Skydropx auth error ${r.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
        continue;
      }
      const data = await r.json();
      if (data.access_token) return data.access_token;
      lastError = new Error('Skydropx no devolvió access_token');
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('No se pudo autenticar con Skydropx');
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

// Normaliza la respuesta JSON:API de un envío a algo plano para el panel.
function parseShipment(json) {
  const d = json && json.data;
  if (!d) return null;
  const a = d.attributes || {};
  const pkgs = (json.included || []).filter(x => x && x.attributes && (x.attributes.label_url !== undefined || x.attributes.tracking_number !== undefined));
  const p = pkgs[0] ? pkgs[0].attributes : {};
  return {
    id: d.id || a.id,
    carrier: a.carrier_name || '',
    status: a.workflow_status || '',
    paymentStatus: a.payment_status || '',
    total: a.total != null ? parseFloat(a.total) : null,
    trackingNumber: a.master_tracking_number || p.tracking_number || null,
    labelUrl: p.label_url || null,
    trackingUrl: p.tracking_url_provider || null,
    trackingStatus: p.tracking_status || null,
    createdAt: a.created_at || null,
    error: a.error_detail && (a.error_detail.error_message_detail || a.error_detail.error_message) || null
  };
}

function buildAddress(p, label) {
  const o = p || {};
  const a = {
    street1: str(o.calle, 100), name: str(o.nombre, 80), company: str(o.empresa || o.nombre, 80),
    phone: str(o.telefono, 20).replace(/[^\d]/g, ''), email: str(o.email, 100),
    reference: str(o.referencia || 'Sin referencia', 100)
  };
  ['street1', 'name', 'phone', 'email'].forEach(k => { if (!a[k]) throw Object.assign(new Error(`Falta el dato "${k}" del ${label}.`), { status: 400 }); });
  return a;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'JSON inválido' }); return; }

  const session = await checkSession(body).catch(() => false);
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return; }

  const clientId = process.env.SKYDROPX_API_KEY;
  const clientSecret = process.env.SKYDROPX_API_SECRET;
  const baseUrl = process.env.SKYDROPX_BASE_URL || 'https://pro.skydropx.com';
  if (!clientId || !clientSecret) { res.status(500).json({ error: 'Faltan SKYDROPX_API_KEY / SKYDROPX_API_SECRET en Vercel.' }); return; }

  try {
    const token = await getAccessToken(baseUrl, clientId, clientSecret);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const call = async (path, opts) => {
      const r = await fetch(`${baseUrl}${path}`, { ...(opts || {}), headers });
      const text = await r.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* no JSON */ }
      return { ok: r.ok, status: r.status, json, text };
    };

    const accion = body.accion;

    if (accion === 'saldo') {
      const r = await call('/api/v1/finance/credits');
      if (!r.ok) { res.status(502).json({ error: `Skydropx saldo error ${r.status}`, detail: r.text.slice(0, 300) }); return; }
      const d = (r.json && r.json.data) || {};
      res.status(200).json({ balance: Number(d.balance), currency: d.currency || 'MXN' });
      return;
    }

    if (accion === 'listar') {
      const r = await call('/api/v1/shipments');
      if (!r.ok) { res.status(502).json({ error: `Skydropx envíos error ${r.status}`, detail: r.text.slice(0, 300) }); return; }
      const list = (r.json && r.json.data) || [];
      const shipments = list.map(x => parseShipment({ data: x })).filter(Boolean);
      res.status(200).json({ shipments });
      return;
    }

    if (accion === 'detalle') {
      const id = str(body.shipment_id, 80);
      if (!id) { res.status(400).json({ error: 'Falta shipment_id' }); return; }
      const r = await call(`/api/v1/shipments/${encodeURIComponent(id)}`);
      if (!r.ok) { res.status(502).json({ error: `Skydropx envío error ${r.status}`, detail: r.text.slice(0, 300) }); return; }
      res.status(200).json({ shipment: parseShipment(r.json) });
      return;
    }

    if (accion === 'crear') {
      const rateId = str(body.rate_id, 80);
      if (!rateId) { res.status(400).json({ error: 'Falta rate_id (cotiza de nuevo y elige una tarifa).' }); return; }
      const shipment = {
        rate_id: rateId,
        unique_shipment: true,
        printing_format: body.formato === 'thermal' ? 'thermal' : 'standard',
        address_from: buildAddress(body.origen, 'remitente'),
        address_to: buildAddress(body.destino, 'destinatario'),
        packages: [{
          package_number: '1',
          package_protected: false,
          consignment_note: str(body.carta_porte || DEFAULT_CONSIGNMENT_NOTE, 20),
          package_type: str(body.tipo_paquete || DEFAULT_PACKAGE_TYPE, 10)
        }]
      };

      // Primero el cuerpo anidado bajo "shipment" (como lo muestra la
      // documentación); si la API lo rechaza por formato (400/422, o sea que
      // no creó nada) se reintenta aplanado. unique_shipment evita duplicados.
      let r = await call('/api/v1/shipments', { method: 'POST', body: JSON.stringify({ shipment }) });
      if (!r.ok && (r.status === 400 || r.status === 422)) {
        const retry = await call('/api/v1/shipments', { method: 'POST', body: JSON.stringify(shipment) });
        if (retry.ok) r = retry; else r = { ...retry, text: `${r.text.slice(0, 200)} | ${retry.text.slice(0, 200)}` };
      }
      if (!r.ok) { res.status(502).json({ error: `Skydropx no pudo crear la guía (HTTP ${r.status})`, detail: r.text.slice(0, 500) }); return; }

      let parsed = parseShipment(r.json);
      const id = parsed && parsed.id;
      // La guía se genera de forma asíncrona (202): se consulta hasta que
      // traiga el PDF de la etiqueta o se acaba el tiempo.
      for (let i = 0; id && i < 8 && !(parsed.labelUrl || parsed.error); i++) {
        await new Promise(ok => setTimeout(ok, 1500));
        const d = await call(`/api/v1/shipments/${encodeURIComponent(id)}`);
        if (d.ok) parsed = parseShipment(d.json) || parsed;
      }
      res.status(200).json({ shipment: parsed });
      return;
    }

    res.status(400).json({ error: 'Acción no válida.' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
