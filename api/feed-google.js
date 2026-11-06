// Vercel serverless function: catálogo de productos para Google Merchant Center (fichas gratuitas,
// pestaña Shopping, resultados con precio y lo que responde la IA de Google). Pública en
// /feed/google.xml (vercel.json); Merchant Center la descarga sola cada día.
//
// RSS 2.0 con el espacio de nombres g: (https://support.google.com/merchants/answer/7052112).
// Solo productos activos con precio y foto. Existencias: ps_stock + movimientos (stock_publico) en todas las sucursales;
// los productos sin registro de existencias (paquetes/promociones armados al momento) van como
// disponibles, igual que en la tienda. Envío: gratis desde $1,500 (Política de envíos); para montos
// menores la tarifa se configura en Merchant Center.
const { sbTodo } = require('../lib/seo-datos.js');
const { productoPath } = require('../lib/url-producto.js');

const ORIGEN = 'https://www.mifiestashop.com';
const ENVIO_GRATIS_DESDE = 1500;

const xml = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const texto = h => String(h || '').replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// GTIN real: 13 dígitos, dígito verificador correcto y que no sea de uso interno (prefijo 2: códigos
// que imprime la propia tienda). Un GTIN falso hace que Google rechace o confunda el producto.
function gtinReal(c) {
  const s = String(c || '');
  if (!/^\d{13}$/.test(s) || s[0] === '2') return null;
  const suma = s.slice(0, 12).split('').reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === Number(s[12]) ? s : null;
}

async function existencias(ids) {
  const total = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    // stock_publico = ps_stock (base) + movimientos del kardex; una sucursal en negativo no resta a las demás.
    const filas = await sbTodo(`/rest/v1/rpc/stock_publico?p_ids=%7B${ids.slice(i, i + 200).join(',')}%7D`);
    for (const f of filas) total.set(Number(f.id_product), (total.get(Number(f.id_product)) || 0) + Math.max(0, Number(f.cantidad) || 0));
  }
  return total;
}

function item(p, m, cat, stock) {
  const precio = Number(p.price) || 0;
  const catImgs = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  const migImgs = m && Array.isArray(m.images) ? m.images.filter(Boolean) : [];
  const imagenes = (migImgs.length > catImgs.length ? migImgs : catImgs).filter(u => /^https?:\/\//.test(u));
  const ruta = productoPath({ id: p.id, linkRewrite: p.link_rewrite, ean13: p.barcode, categoryRewrite: cat && cat.link_rewrite });
  if (!(precio > 0) || !imagenes.length || !ruta) return '';
  const nombre = (m && m.name) || p.name;
  const desc = texto((m && m.description) || p.description || p.description_short || p.meta_description || nombre).slice(0, 4900);
  const gtin = gtinReal(p.barcode);
  const disponible = stock === undefined ? true : stock > 0;
  const lineas = [
    `<g:id>${p.id}</g:id>`,
    `<g:title>${xml(String(nombre).slice(0, 150))}</g:title>`,
    `<g:description>${xml(desc)}</g:description>`,
    `<g:link>${xml(ORIGEN + ruta)}</g:link>`,
    `<g:image_link>${xml(imagenes[0])}</g:image_link>`,
    ...imagenes.slice(1, 11).map(u => `<g:additional_image_link>${xml(u)}</g:additional_image_link>`),
    `<g:availability>${disponible ? 'in_stock' : 'out_of_stock'}</g:availability>`,
    `<g:price>${precio.toFixed(2)} MXN</g:price>`,
    `<g:condition>new</g:condition>`,
    `<g:brand>Mi Fiestashop</g:brand>`,
    gtin ? `<g:gtin>${gtin}</g:gtin>` : `<g:identifier_exists>no</g:identifier_exists>`,
    cat && cat.name ? `<g:product_type>${xml(`Artículos para fiesta > ${cat.name}`)}</g:product_type>` : '',
    precio >= ENVIO_GRATIS_DESDE ? `<g:shipping><g:country>MX</g:country><g:price>0.00 MXN</g:price></g:shipping>` : ''
  ].filter(Boolean);
  return `<item>${lineas.join('')}</item>`;
}

async function generarFeed() {
  const [productos, migrados, categorias] = await Promise.all([
    sbTodo('/rest/v1/catalogo_productos?select=id,name,link_rewrite,barcode,category_id,price,images,description,description_short,meta_description&active=eq.true&order=id.asc'),
    sbTodo('/rest/v1/productos_migrados?select=id,name,description,images'),
    sbTodo('/rest/v1/ps_categorias?select=id,name,link_rewrite,active')
  ]);
  const mig = new Map(migrados.map(m => [Number(m.id), m]));
  const cats = new Map(categorias.map(c => [Number(c.id), c]));
  const stock = await existencias(productos.map(p => p.id));
  const items = productos.map(p => item(p, mig.get(Number(p.id)), cats.get(Number(p.category_id)), stock.has(Number(p.id)) ? stock.get(Number(p.id)) : undefined)).filter(Boolean);
  return { total: items.length, xml: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>Mi Fiestashop</title>
<link>${ORIGEN}/</link>
<description>Artículos para fiesta, batucada, bodas y eventos al mayoreo y menudeo en México.</description>
${items.join('\n')}
</channel>
</rss>
` };
}

module.exports = async function handler(req, res) {
  try {
    const { xml: cuerpo } = await generarFeed();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(cuerpo);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?><error>${xml(e.message)}</error>`);
  }
};
module.exports.generarFeed = generarFeed;
module.exports.gtinReal = gtinReal;
module.exports.item = item;
