// Conexión con Google para el módulo SEO:
//   - Search Console (posiciones reales, clics, impresiones, CTR, indexación, envío de sitemap).
//     Cuenta de servicio: GSC_SERVICE_ACCOUNT_JSON (el JSON completo de la llave) y GSC_SITE
//     (propiedad; por defecto "sc-domain:mifiestashop.com"). El correo de la cuenta de servicio
//     debe agregarse como usuario de la propiedad en Search Console.
//   - PageSpeed Insights (velocidad y Core Web Vitals). PAGESPEED_API_KEY es opcional (sin
//     llave Google permite pocas consultas al día).
const crypto = require('crypto');

const SITIO_DEFAULT = 'sc-domain:mifiestashop.com';

function cuentaServicio() {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (!j.client_email || !j.private_key) return null;
    return { email: j.client_email, key: j.private_key.replace(/\\n/g, '\n') };
  } catch (e) { return null; }
}
function sitio() { return process.env.GSC_SITE || SITIO_DEFAULT; }
function gscConfigurado() { return !!cuentaServicio(); }

const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

let tokenCache = null;
async function tokenGoogle() {
  const cs = cuentaServicio();
  if (!cs) throw new Error('Search Console no está conectado (falta GSC_SERVICE_ACCOUNT_JSON en Vercel).');
  if (tokenCache && tokenCache.expira > Date.now() + 60000) return tokenCache.token;
  const ahora = Math.floor(Date.now() / 1000);
  const enc = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: cs.email, scope: 'https://www.googleapis.com/auth/webmasters',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600
  }));
  const firma = crypto.createSign('RSA-SHA256').update(`${enc}.${claim}`).sign(cs.key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${enc}.${claim}.${b64url(firma)}` }).toString()
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Google no dio acceso (${d.error_description || d.error || r.status}). Revisa la llave de la cuenta de servicio.`);
  tokenCache = { token: d.access_token, expira: Date.now() + (d.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function llamarGoogle(url, opts = {}) {
  const token = await tokenGoogle();
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const txt = await r.text();
  const d = txt ? (() => { try { return JSON.parse(txt); } catch (e) { return { raw: txt }; } })() : {};
  if (!r.ok) {
    const msg = (d.error && d.error.message) || `HTTP ${r.status}`;
    if (r.status === 403) throw new Error(`Search Console negó el acceso: agrega el correo de la cuenta de servicio como usuario de la propiedad ${sitio()}. (${msg})`);
    throw new Error(`Search Console: ${msg}`);
  }
  return d;
}

const fecha = d => d.toISOString().slice(0, 10);
// Search Console publica los datos con ~2-3 días de retraso.
function rango(dias, finHaceDias = 3) {
  const fin = new Date(Date.now() - finHaceDias * 864e5);
  const ini = new Date(fin.getTime() - (dias - 1) * 864e5);
  return { startDate: fecha(ini), endDate: fecha(fin) };
}

// dimensiones: ['query'] | ['page'] | ['query','page'] | ['date'] ...
async function analitica({ startDate, endDate, dimensiones = ['query'], limite = 250, filtros = [] }) {
  const body = { startDate, endDate, dimensions: dimensiones, rowLimit: Math.min(25000, limite), dataState: 'all' };
  if (filtros.length) body.dimensionFilterGroups = [{ filters: filtros }];
  const d = await llamarGoogle(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(sitio())}/searchAnalytics/query`, { method: 'POST', body: JSON.stringify(body) });
  return (d.rows || []).map(r => ({
    keys: r.keys, clics: r.clicks || 0, impresiones: r.impressions || 0,
    ctr: Math.round((r.ctr || 0) * 10000) / 100, posicion: Math.round((r.position || 0) * 10) / 10
  }));
}

async function inspeccionarUrl(url) {
  const d = await llamarGoogle('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST', body: JSON.stringify({ inspectionUrl: url, siteUrl: sitio(), languageCode: 'es-MX' })
  });
  const r = (d.inspectionResult && d.inspectionResult.indexStatusResult) || {};
  return {
    veredicto: r.verdict, cobertura: r.coverageState, indexacion: r.indexingState, rastreo: r.pageFetchState,
    ultimo_rastreo: r.lastCrawlTime, canonica_google: r.googleCanonical, canonica_usuario: r.userCanonical,
    robots: r.robotsTxtState, enlace: d.inspectionResult && d.inspectionResult.inspectionResultLink
  };
}

async function enviarSitemap(urlSitemap) {
  await llamarGoogle(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(sitio())}/sitemaps/${encodeURIComponent(urlSitemap)}`, { method: 'PUT' });
  return { enviado: true };
}

async function listarSitemaps() {
  const d = await llamarGoogle(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(sitio())}/sitemaps`);
  return (d.sitemap || []).map(s => ({
    ruta: s.path, ultimo_envio: s.lastSubmitted, ultima_descarga: s.lastDownloaded, pendiente: s.isPending,
    errores: Number(s.errors || 0), advertencias: Number(s.warnings || 0),
    enviadas: (s.contents || []).reduce((t, c) => t + Number(c.submitted || 0), 0),
    indexadas: (s.contents || []).reduce((t, c) => t + Number(c.indexed || 0), 0)
  }));
}

// PageSpeed Insights (Lighthouse). Tarda de 15 a 40 s por URL.
async function pagespeed(url, estrategia = 'mobile') {
  const qs = new URLSearchParams({ url, strategy: estrategia, locale: 'es' });
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach(c => qs.append('category', c));
  if (process.env.PAGESPEED_API_KEY) qs.set('key', process.env.PAGESPEED_API_KEY);
  const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`, { signal: AbortSignal.timeout(55000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d.error && d.error.message) || `HTTP ${r.status}`;
    if (r.status === 429) throw new Error('Google limitó las mediciones de velocidad por hoy. Agrega PAGESPEED_API_KEY en Vercel (es gratis) para medir más.');
    throw new Error(`PageSpeed: ${msg}`);
  }
  const lh = d.lighthouseResult || {};
  const cat = k => (lh.categories && lh.categories[k] && lh.categories[k].score != null) ? Math.round(lh.categories[k].score * 100) : null;
  const au = k => (lh.audits && lh.audits[k]) || {};
  const campo = (d.loadingExperience && d.loadingExperience.metrics) || {};
  // Recomendaciones con más ahorro estimado.
  const oportunidades = Object.values(lh.audits || {})
    .filter(a => a.details && a.details.type === 'opportunity' && a.score !== null && a.score < 0.9)
    .map(a => ({ titulo: a.title, ahorro_ms: Math.round(a.details.overallSavingsMs || 0) }))
    .sort((a, b) => b.ahorro_ms - a.ahorro_ms).slice(0, 6);
  return {
    url, estrategia,
    performance: cat('performance'), seo: cat('seo'), accesibilidad: cat('accessibility'), buenas_practicas: cat('best-practices'),
    lcp_ms: Math.round(au('largest-contentful-paint').numericValue || 0) || null,
    cls: au('cumulative-layout-shift').numericValue != null ? Math.round(au('cumulative-layout-shift').numericValue * 1000) / 1000 : null,
    tbt_ms: Math.round(au('total-blocking-time').numericValue || 0) || null,
    fcp_ms: Math.round(au('first-contentful-paint').numericValue || 0) || null,
    si_ms: Math.round(au('speed-index').numericValue || 0) || null,
    detalle: {
      oportunidades,
      usuarios_reales: campo.LARGEST_CONTENTFUL_PAINT_MS ? {
        lcp_ms: campo.LARGEST_CONTENTFUL_PAINT_MS.percentile, lcp: campo.LARGEST_CONTENTFUL_PAINT_MS.category,
        inp_ms: campo.INTERACTION_TO_NEXT_PAINT && campo.INTERACTION_TO_NEXT_PAINT.percentile,
        cls: campo.CUMULATIVE_LAYOUT_SHIFT_SCORE && campo.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
      } : null
    }
  };
}

module.exports = { gscConfigurado, sitio, analitica, inspeccionarUrl, enviarSitemap, listarSitemaps, pagespeed, rango, cuentaServicio };
