// Búsqueda de competencia en Mercado Libre México (MLM) para un producto del catálogo.
//
// En Mercado Libre casi todo se vende por paquete ("Collar hawaiano 50 pzas", "Kit 12 antifaces"),
// así que comparar el precio de la publicación contra nuestro precio por pieza engaña. Aquí se saca
// cuántas piezas trae cada publicación (atributos de ML como UNITS_PER_PACK, o el título) y se
// compara precio por pieza contra precio por pieza. Nuestro producto también puede ser un paquete
// ("Globo salchicha (200 pzas)"), así que se aplica lo mismo a nuestro nombre.
//
// La API de búsqueda de ML ya no responde sin token: pide una app registrada en
// developers.mercadolibre.com.mx (ML_CLIENT_ID / ML_CLIENT_SECRET en Vercel); el token de app
// (client_credentials) basta para búsquedas públicas.

const ML_API = 'https://api.mercadolibre.com';
const SITE = 'MLM';

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const PALABRAS_VACIAS = new Set(['de', 'la', 'el', 'los', 'las', 'para', 'con', 'en', 'y', 'del', 'al', 'un', 'una',
  'pzas', 'pza', 'piezas', 'pieza', 'pz', 'pzs', 'pcs', 'paquete', 'kit', 'set', 'unidades', 'x']);

function palabrasClave(nombre) {
  return normalizar(nombre).split(' ').filter(w => w.length > 1 && !PALABRAS_VACIAS.has(w) && !/^\d+$/.test(w));
}

// Cuántas piezas trae un texto ("50 pzas", "Paquete de 12", "x24", "c/100", "2 docenas", "10 pares").
// Sin una cantidad explícita con su unidad se asume 1: así "Vaso 16 oz" o "Globo 18 pulgadas" no se
// confunden con un paquete.
function piezasDeTexto(texto) {
  const t = normalizar(texto);
  const pats = [
    /(\d{1,5})\s*(?:pzas?|pzs|piezas?|pcs|unidades|uds?|pares|par)\b/,
    /(?:paquete|pack|kit|set|bolsa|caja|lote|juego)\s*(?:de|c|con)?\s*(\d{1,5})\b/,
    /(?:^|[a-z]\s)(?:c|x)\s*(\d{1,5})\b(?!\s*(?:cm|mm|mts?|m|pulgadas|in|oz|ml|lts?|l|kg|g|gr)\b)/,
    /\b(\d{1,5})\s*(?:x|c)\b(?!\s*\d)/
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) { const n = parseInt(m[1], 10); if (n >= 2 && n <= 20000) return n; }
  }
  const doc = /(\d{1,3})?\s*docenas?\b/.exec(t);
  if (doc) return 12 * (doc[1] ? parseInt(doc[1], 10) : 1);
  if (/\bciento\b/.test(t)) return 100;
  return 1;
}

// Piezas de una publicación de ML: primero los atributos estructurados, luego el título.
const ATRIBUTOS_PIEZAS = ['UNITS_PER_PACK', 'UNITS_PER_PACKAGE', 'PACKAGE_UNITS', 'UNITS_PER_KIT', 'PIECES_NUMBER', 'NUMBER_OF_PIECES'];
function piezasDePublicacion(item) {
  for (const a of (item && item.attributes) || []) {
    if (!ATRIBUTOS_PIEZAS.includes(a.id)) continue;
    const n = parseInt(a.value_name || (a.value_struct && a.value_struct.number), 10);
    if (n >= 2 && n <= 20000) return n;
  }
  return piezasDeTexto(item && item.title);
}

// Qué tanto se parece el título de la publicación a nuestro producto (0 a 1): proporción de nuestras
// palabras clave que aparecen en el título.
function parecido(nombre, titulo) {
  const claves = palabrasClave(nombre);
  if (!claves.length) return 0;
  const enTitulo = new Set(normalizar(titulo).split(' '));
  // "globos" vs "globo": se compara también sin la "s" final.
  const tiene = w => enTitulo.has(w) || enTitulo.has(w.replace(/s$/, '')) || enTitulo.has(w + 's') || enTitulo.has(w + 'es');
  return claves.filter(tiene).length / claves.length;
}

function consultaDe(nombre) {
  // Sin la cantidad del paquete: "Globo salchicha (200 pzas)" busca "globo salchicha" y se
  // compara por pieza.
  return palabrasClave(nombre).slice(0, 6).join(' ');
}

let tokenCache = null; // { token, expira }
async function tokenML() {
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  const id = process.env.ML_CLIENT_ID, secret = process.env.ML_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Faltan ML_CLIENT_ID / ML_CLIENT_SECRET en Vercel (app de developers.mercadolibre.com.mx).');
  if (tokenCache && tokenCache.expira > Date.now() + 60000) return tokenCache.token;
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString()
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Mercado Libre no dio token (HTTP ${r.status}${d.message ? ': ' + d.message : ''})`);
  tokenCache = { token: d.access_token, expira: Date.now() + (Number(d.expires_in) || 21600) * 1000 };
  return tokenCache.token;
}

const PARECIDO_MINIMO = 0.6;

// Busca el producto en ML y regresa hasta `max` publicaciones parecidas, ordenadas de menor a mayor
// precio por pieza: [{ nombre, titulo, precio, piezas, precio_pieza, enlace, fuente, buscado_at }].
async function buscarCompetenciaML(producto, { max = 3 } = {}) {
  const q = consultaDe(producto.name);
  if (!q) return { consulta: q, resultados: [] };
  const token = await tokenML();
  const url = `${ML_API}/sites/${SITE}/search?q=${encodeURIComponent(q)}&limit=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Búsqueda en Mercado Libre -> HTTP ${r.status}`);
  const d = await r.json();
  const ahora = new Date().toISOString();
  const vistos = new Set();
  const resultados = (d.results || [])
    .filter(it => it && Number(it.price) > 0 && it.permalink && (!it.currency_id || it.currency_id === 'MXN'))
    .map(it => {
      const piezas = piezasDePublicacion(it);
      return {
        nombre: 'Mercado Libre',
        titulo: String(it.title || '').slice(0, 160),
        precio: Math.round(Number(it.price) * 100) / 100,
        piezas,
        precio_pieza: Math.round((Number(it.price) / piezas) * 100) / 100,
        enlace: String(it.permalink).slice(0, 500),
        fuente: 'mercadolibre',
        buscado_at: ahora,
        _parecido: parecido(producto.name, it.title)
      };
    })
    .filter(x => x._parecido >= PARECIDO_MINIMO)
    .filter(x => { if (vistos.has(x.enlace)) return false; vistos.add(x.enlace); return true; })
    .sort((a, b) => a.precio_pieza - b.precio_pieza)
    .slice(0, max)
    .map(({ _parecido, ...x }) => x);
  return { consulta: q, resultados };
}

// Nuestro precio por pieza (si nuestro producto es un paquete, se divide entre sus piezas).
function nuestroPrecioPieza(producto) {
  const piezas = piezasDeTexto(producto.name);
  const precio = Number(producto.price) || 0;
  return { piezas, precio_pieza: piezas > 0 ? Math.round((precio / piezas) * 100) / 100 : precio };
}

module.exports = { buscarCompetenciaML, piezasDeTexto, piezasDePublicacion, parecido, consultaDe, nuestroPrecioPieza, normalizar };

// Guarda los resultados de ML en producto_privado.competencia sin tocar los competidores capturados
// a mano en el editor del producto (los que no traen fuente 'mercadolibre').
async function guardarCompetenciaML({ supabaseUrl, serviceKey, id, resultados }) {
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const r = await fetch(`${supabaseUrl}/rest/v1/producto_privado?id=eq.${id}&select=competencia`, { headers: h });
  if (!r.ok) throw new Error(`leer producto_privado -> HTTP ${r.status}`);
  const actual = ((await r.json())[0] || {}).competencia;
  const manuales = (Array.isArray(actual) ? actual : []).filter(c => c && c.fuente !== 'mercadolibre');
  const w = await fetch(`${supabaseUrl}/rest/v1/producto_privado?on_conflict=id`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ id, competencia: [...manuales, ...resultados], updated_at: new Date().toISOString() }])
  });
  if (!w.ok) throw new Error(`guardar producto_privado -> HTTP ${w.status}`);
}

module.exports.guardarCompetenciaML = guardarCompetenciaML;
