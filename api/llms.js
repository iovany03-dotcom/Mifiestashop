// Vercel serverless function: /llms.txt (vercel.json) — resumen de la tienda en Markdown para
// asistentes de IA (propuesta llmstxt.org): qué vende Mi Fiestashop, sucursales, políticas,
// categorías con su descripción y los productos más vendidos, con ligas. Se arma con los datos
// reales (catálogo, categorías, ventas) y se guarda una hora en el CDN.
const { sbTodo } = require('../lib/seo-datos.js');
const { productoPath } = require('../lib/url-producto.js');

const ORIGEN = 'https://www.mifiestashop.com';
const texto = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const corto = (s, n) => { const t = texto(s); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t; };
const dinero = n => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;

async function generar() {
  const [cats, prods, ventas] = await Promise.all([
    sbTodo('/rest/v1/ps_categorias?select=id,name,link_rewrite,description,meta_description,active&active=is.true'),
    sbTodo('/rest/v1/catalogo_productos?select=id,name,link_rewrite,barcode,category_id,price,price_mayoreo,price_mayoreo_desde_unidades,meta_description&active=eq.true'),
    sbTodo('/rest/v1/pos_ventas_producto_mes?select=product_id,units').catch(() => [])
  ]);
  const catPorId = new Map(cats.map(c => [Number(c.id), c]));
  const porCat = new Map();
  prods.forEach(p => porCat.set(Number(p.category_id), (porCat.get(Number(p.category_id)) || 0) + 1));
  const vendidos = new Map();
  ventas.forEach(v => vendidos.set(Number(v.product_id), (vendidos.get(Number(v.product_id)) || 0) + (Number(v.units) || 0)));
  const url = p => ORIGEN + productoPath({ id: p.id, linkRewrite: p.link_rewrite, ean13: p.barcode, categoryRewrite: (catPorId.get(Number(p.category_id)) || {}).link_rewrite });

  const categorias = cats.filter(c => ![1, 2, 266].includes(Number(c.id)) && c.link_rewrite && porCat.get(Number(c.id)))
    .sort((a, b) => (porCat.get(Number(b.id)) || 0) - (porCat.get(Number(a.id)) || 0));
  const top = prods.filter(p => Number(p.price) > 0 && p.link_rewrite).sort((a, b) => (vendidos.get(Number(b.id)) || 0) - (vendidos.get(Number(a.id)) || 0)).slice(0, 60);

  return `# Mi Fiestashop

> Tienda mexicana de artículos para fiesta: batucada (sombreros de hule espuma, lentes, collares, pelucas, accesorios neón y luminosos), globos, decoración, pirotecnia fría y artículos para bodas, XV años, cumpleaños, Halloween y fiestas temáticas. Venta por menudeo y mayoreo (precio de mayoreo desde 3 piezas), envíos a todo México y tiendas físicas en CDMX, Puebla y Querétaro.

- Tienda en línea: ${ORIGEN}/
- WhatsApp: +52 56 1262 2146 (https://wa.me/525612622146)
- Formas de pago: tarjeta de crédito o débito (Mercado Pago), transferencia y en sucursal. Factura electrónica (CFDI 4.0): ${ORIGEN}/facturar

## Sucursales

- CDMX: Rumania 613, Col. Portales, Benito Juárez, Ciudad de México
- Puebla: C. 35 Sur 2901, Sta. Cruz Los Ángeles, Puebla
- Querétaro: C. Gral. Lázaro Cárdenas 67, Casa Blanca, Querétaro
- También se puede recoger el pedido en sucursal sin costo de envío.

## Envíos y devoluciones

- Envío gratis en compras desde $1,500 MXN dentro de la República Mexicana (no aplica en zonas extendidas ni en productos personalizados): ${ORIGEN}/pagina/politica-de-envio-gratis-mi-fiesta-shop
- Tiempos de entrega: CDMX, Puebla y Querétaro de 1 a 3 días hábiles; resto del país de 2 a 6 días hábiles según la paquetería.
- Devoluciones: ver ${ORIGEN}/pagina/politica-de-devolucion-mi-fiesta-shop

## Categorías

${categorias.map(c => `- [${c.name}](${ORIGEN}/${c.id}-${c.link_rewrite}): ${porCat.get(Number(c.id))} productos.${(c.meta_description || c.description) ? ' ' + corto(c.meta_description || c.description, 220) : ''}`).join('\n')}

## Productos más vendidos

${top.map(p => `- [${p.name}](${url(p)}): ${dinero(p.price)}${Number(p.price_mayoreo) > 0 && Number(p.price_mayoreo) < Number(p.price) && p.price_mayoreo_desde_unidades > 1 ? `, mayoreo ${dinero(p.price_mayoreo)} desde ${p.price_mayoreo_desde_unidades} piezas` : ''}.${p.meta_description ? ' ' + corto(p.meta_description, 160) : ''}`).join('\n')}

## Más información

- Catálogo completo (sitemap): ${ORIGEN}/sitemap.xml
- Catálogo de productos con precio y existencias (Google Merchant): ${ORIGEN}/feed/google.xml
- Blog con guías para fiestas: ${ORIGEN}/blog
`;
}

module.exports = async function handler(req, res) {
  try {
    const cuerpo = await generar();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(cuerpo);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).send(`Error: ${e.message}`);
  }
};
module.exports.generar = generar;
