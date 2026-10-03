// Cliente de la API Web de Facturama (CFDI 4.0, un solo RFC emisor).
// Docs: https://facturama.mx/docs/es/api-web/crear-cfdi
//
// Env vars (Vercel):
//   FACTURAMA_USER, FACTURAMA_PASSWORD  credenciales de la cuenta (HTTP Basic)
//   FACTURAMA_ENV                       "production" para timbrar de verdad; cualquier otro valor = sandbox
//   FACTURAMA_EXPEDITION_PLACE          CP del lugar de expedición (el del emisor en su CSD)
//   FACTURAMA_SERIE                     serie opcional (ej. "MFS")
//   FACTURAMA_IVA_INCLUIDO              "0" si los precios del sistema NO traen IVA (default: sí lo traen)
const HOSTS = { production: 'https://api.facturama.mx', sandbox: 'https://apisandbox.facturama.mx' };

const entorno = () => (String(process.env.FACTURAMA_ENV || '').toLowerCase() === 'production' ? 'production' : 'sandbox');
const baseUrl = () => HOSTS[entorno()];
const facturamaConfigurado = () => !!(process.env.FACTURAMA_USER && process.env.FACTURAMA_PASSWORD && process.env.FACTURAMA_EXPEDITION_PLACE);

async function fcFetch(path, opts) {
  if (!process.env.FACTURAMA_USER || !process.env.FACTURAMA_PASSWORD) throw new Error('Faltan FACTURAMA_USER / FACTURAMA_PASSWORD en Vercel.');
  const auth = Buffer.from(`${process.env.FACTURAMA_USER}:${process.env.FACTURAMA_PASSWORD}`).toString('base64');
  const r = await fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...(opts && opts.headers) }
  });
  const texto = await r.text();
  let data = null;
  try { data = texto ? JSON.parse(texto) : null; } catch (e) { data = { raw: texto }; }
  if (!r.ok) {
    const det = data && (data.Message || data.message || (data.ModelState && Object.values(data.ModelState).flat().join(' | ')) || data.raw);
    const err = new Error(`Facturama ${r.status}${det ? ': ' + String(det).slice(0, 400) : ''}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r6 = n => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;

// Concepto del CFDI a partir de una línea del sistema. `precio` es el precio unitario con IVA
// (ivaIncluido, lo normal en la tienda) o sin IVA.
function armarConcepto(it, ivaIncluido) {
  const qty = Number(it.qty) > 0 ? Number(it.qty) : 1;
  const bruto = Number(it.price) * qty;
  const subtotal = ivaIncluido ? r2(bruto / 1.16) : r2(bruto);
  const iva = ivaIncluido ? r2(bruto - subtotal) : r2(subtotal * 0.16);
  return {
    ProductCode: String(it.claveSat || '60141104'),   // 60141104 = juguetes/artículos de fiesta (cámbialo por producto si hace falta)
    IdentificationNumber: String(it.sku || it.id || '').slice(0, 100) || undefined,
    Description: String(it.name || 'Producto').slice(0, 1000),
    Unit: 'Pieza',
    UnitCode: 'H87',
    UnitPrice: r6(subtotal / qty),
    Quantity: qty,
    Subtotal: subtotal,
    TaxObject: '02',
    Taxes: [{ Name: 'IVA', Rate: 0.16, Base: subtotal, Total: iva, IsRetention: false }],
    Total: r2(subtotal + iva)
  };
}

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

function validarReceptor(rec) {
  const rfc = String(rec && rec.rfc || '').trim().toUpperCase();
  const nombre = String(rec && rec.nombre || '').trim().toUpperCase();
  const cp = String(rec && rec.cp || '').trim();
  const regimen = String(rec && rec.regimen || '').trim();
  const usoCfdi = String(rec && rec.usoCfdi || '').trim().toUpperCase();
  if (!RFC_RE.test(rfc)) throw new Error('RFC del cliente inválido.');
  if (!nombre) throw new Error('Falta el nombre o razón social del cliente (tal cual está en su constancia fiscal).');
  if (!/^\d{5}$/.test(cp)) throw new Error('Falta el código postal fiscal del cliente (5 dígitos).');
  if (!/^\d{3}$/.test(regimen)) throw new Error('Falta el régimen fiscal del cliente (clave de 3 dígitos, ej. 612).');
  if (!/^[A-Z]{1,2}\d{2}$/.test(usoCfdi)) throw new Error('Falta el uso del CFDI (ej. G03).');
  return { Rfc: rfc, Name: nombre, TaxZipCode: cp, FiscalRegime: regimen, CfdiUse: usoCfdi };
}

// Arma el JSON de POST /3/cfdis. `fecha` e `folio` se generan una sola vez por operación
// (Facturama los usa como llave de idempotencia).
function armarCfdi({ receptor, items, formaPago, metodoPago, folio, fecha, referencia }) {
  if (!Array.isArray(items) || !items.length) throw new Error('No hay conceptos que facturar.');
  const ivaIncluido = process.env.FACTURAMA_IVA_INCLUIDO !== '0';
  const cfdi = {
    NameId: '1',
    Currency: 'MXN',
    Folio: String(folio),
    CfdiType: 'I',
    PaymentForm: String(formaPago || '99'),
    PaymentMethod: metodoPago === 'PPD' ? 'PPD' : 'PUE',
    ExpeditionPlace: String(process.env.FACTURAMA_EXPEDITION_PLACE || ''),
    Date: fecha,
    Exportation: '01',
    Receiver: validarReceptor(receptor),
    Items: items.map(it => armarConcepto(it, ivaIncluido))
  };
  if (process.env.FACTURAMA_SERIE) cfdi.Serie = String(process.env.FACTURAMA_SERIE);
  if (referencia) cfdi.OrderNumber = String(referencia).slice(0, 50);
  cfdi.Items.forEach(c => { if (c.IdentificationNumber === undefined) delete c.IdentificationNumber; });
  return cfdi;
}

const timbrar = cfdi => fcFetch('/3/cfdis', { method: 'POST', body: JSON.stringify(cfdi) });
const consultar = id => fcFetch(`/cfdi/${encodeURIComponent(id)}?type=issued`);
const descargar = (formato, id) => fcFetch(`/cfdi/${formato}/issued/${encodeURIComponent(id)}`);
function cancelar(id, motivo, uuidSustituto) {
  const q = new URLSearchParams({ type: 'issued', motive: motivo });
  if (motivo === '01') q.set('uuidReplacement', uuidSustituto);
  return fcFetch(`/cfdi/${encodeURIComponent(id)}?${q}`, { method: 'DELETE' });
}
function enviarCorreo(id, email, asunto) {
  const q = new URLSearchParams({ CfdiType: 'issued', CfdiId: id, Email: email });
  if (asunto) q.set('Subject', asunto);
  return fcFetch(`/Cfdi?${q}`, { method: 'POST' });
}

module.exports = { entorno, facturamaConfigurado, armarCfdi, armarConcepto, validarReceptor, timbrar, consultar, descargar, cancelar, enviarCorreo };
