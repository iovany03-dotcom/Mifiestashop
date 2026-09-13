// Vercel serverless function: fetches PrestaShop CMS pages
// (resource "content_management_system") — used to render pages like
// "Aviso de privacidad", "Políticas de devolución", etc. on the public
// storefront with its own design.
//
// GET /api/paginas            -> { pages: [{ id, title, slug }] }            (solo Ayuda y Legal, para el footer)
// GET /api/paginas?all=1      -> { pages: [{ id, title, slug, inFooter }] }  (todas, para el Backoffice)
// GET /api/paginas?slug=xyz   -> { page: { id, title, description, content, slug } }
// GET /api/paginas?id=5       -> { page: { id, title, description, content, slug } }
//
// El listado por defecto (sin slug/id/all) solo devuelve las páginas de
// "Ayuda y Legal" que deben aparecer en el footer de la tienda — se
// filtra por palabras clave en el título para no traer TODAS las
// páginas CMS que existan en PrestaShop. Ajusta FOOTER_PAGE_KEYWORDS si
// agregas o quitas páginas. El Backoffice usa ?all=1 para listarlas
// todas (marcando cuáles están en el footer) y poder revisarlas.
//
// Requires env vars:
//   PS_BASE_URL   e.g. https://www.mifiestashop.com
//   PS_API_KEY    the PrestaShop webservice key

// Palabras clave (sin acentos, en minúsculas) que debe contener el título
// de una página para mostrarse en el footer de la tienda.
const FOOTER_PAGE_KEYWORDS = ['envio gratis', 'privacidad', 'devolucion'];

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Cuando la página existe en PrestaShop pero su campo "content" está vacío
// (la página se creó como cascarón pero nunca se redactó), se usa este
// contenido de referencia en vez de mostrar la página en blanco. Se
// redactó con los datos reales de la tienda (sucursales, envío gratis,
// WhatsApp) y sirve como borrador: lo ideal es que el dueño de la tienda
// lo revise y lo edite directamente en PrestaShop cuando pueda.
const FALLBACK_CONTENT = [
  {
    keyword: 'envio gratis',
    html: `
      <p>En <b>Mi Fiestashop</b> queremos que recibas tus artículos de fiesta lo más rápido posible y sin costos sorpresa. Así funciona nuestro envío:</p>
      <h2>Envío gratis</h2>
      <ul>
        <li>Envío <b>gratis</b> en compras mayores a <b>$1,500 MXN</b> a cualquier parte de México.</li>
        <li>En pedidos menores, el costo de envío se calcula según tu código postal y el peso/volumen del pedido, y se muestra antes de confirmar tu compra.</li>
      </ul>
      <h2>Tiempos de entrega</h2>
      <ul>
        <li>Ciudad de México, Puebla y Querétaro: 1 a 3 días hábiles.</li>
        <li>Resto de la República: 2 a 6 días hábiles, según la paquetería y el destino.</li>
      </ul>
      <h2>Recolección en sucursal</h2>
      <p>Si prefieres recoger tu pedido sin costo de envío, puedes hacerlo en cualquiera de nuestras sucursales:</p>
      <ul>
        <li>CDMX: Rumania 613, Col. Portales, Benito Juárez</li>
        <li>Querétaro: C. Gral. Lázaro Cárdenas 67, Casa Blanca</li>
        <li>Puebla: C. 35 Sur 2901, Sta. Cruz Los Ángeles</li>
      </ul>
      <p>¿Dudas sobre tu envío? Escríbenos por WhatsApp al <a href="https://wa.me/525612622146">561 262 2146</a>.</p>
    `
  },
  {
    keyword: 'privacidad',
    html: `
      <p><b>Mi Fiestashop</b>, con sucursales en Ciudad de México, Querétaro y Puebla, es responsable del uso y protección de tus datos personales, de conformidad con la Ley Federal de Protección de Datos Personales en Posesión de los Particulares.</p>
      <h2>¿Qué datos recabamos?</h2>
      <p>Para procesar tus pedidos y brindarte atención podemos solicitar: nombre completo, correo electrónico, teléfono, dirección de envío y facturación, y datos de pago (procesados de forma segura por nuestros proveedores de cobro; nunca almacenamos los datos completos de tu tarjeta).</p>
      <h2>¿Para qué usamos tus datos?</h2>
      <ul>
        <li>Procesar y dar seguimiento a tus pedidos y envíos.</li>
        <li>Emitir facturas cuando lo solicites.</li>
        <li>Brindarte atención y soporte por WhatsApp o correo.</li>
        <li>Enviarte promociones y novedades, solo si aceptaste recibirlas.</li>
      </ul>
      <h2>Derechos ARCO</h2>
      <p>Puedes solicitar en cualquier momento el Acceso, Rectificación, Cancelación u Oposición (derechos ARCO) al tratamiento de tus datos personales, escribiéndonos por WhatsApp al <a href="https://wa.me/525612622146">561 262 2146</a>.</p>
      <h2>Cambios a este aviso</h2>
      <p>Podemos actualizar este aviso de privacidad; los cambios se publicarán en esta misma página.</p>
    `
  },
  {
    keyword: 'devolucion',
    html: `
      <p>Queremos que quedes satisfecho con tu compra. Si algo no fue lo que esperabas, esto es lo que necesitas saber:</p>
      <h2>Plazo para cambios y devoluciones</h2>
      <p>Cuentas con <b>5 días hábiles</b> a partir de que recibes tu pedido para solicitar un cambio o devolución.</p>
      <h2>Condiciones</h2>
      <ul>
        <li>El producto debe estar sin uso, en su empaque original y con todos sus accesorios.</li>
        <li>Conserva tu ticket o comprobante de compra.</li>
        <li>Por higiene y seguridad, los antifaces, artículos de pirotecnia fría y productos personalizados <b>no tienen cambio ni devolución</b>, salvo defecto de fábrica.</li>
      </ul>
      <h2>¿Cómo solicitar tu devolución?</h2>
      <p>Escríbenos por WhatsApp al <a href="https://wa.me/525612622146">561 262 2146</a> con tu número de pedido y el motivo. Te indicaremos si el producto se recoge, se envía o se cambia directamente en sucursal.</p>
      <h2>Reembolsos</h2>
      <p>Una vez confirmado que el producto cumple las condiciones anteriores, el reembolso se realiza por el mismo medio de pago, o como saldo a favor para tu siguiente compra, según prefieras.</p>
    `
  }
];

function fallbackContentFor(title) {
  const norm = normalize(title);
  const match = FALLBACK_CONTENT.find(f => norm.includes(f.keyword));
  return match ? match.html : '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    res.status(200).json({ fallback: true, pages: [] });
    return;
  }

  // Extrae el primer valor de un campo multi-idioma de PrestaShop (array u objeto),
  // garantizando que el resultado sea siempre un string usable.
  function firstLangValue(field, fallback) {
    let val = field;
    if (Array.isArray(field)) {
      val = field[0]?.value;
      if (val === undefined) val = field[0];
    } else if (field && typeof field === 'object') {
      val = field.value !== undefined ? field.value : Object.values(field)[0];
    }
    if (typeof val !== 'string' || val === '') return fallback;
    return val;
  }

  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };
  const { id, slug, all } = req.query;

  try {
    if (id || slug) {
      let targetId = id;

      if (!targetId && slug) {
        const listUrl = `${baseUrl}/api/content_management_system?display=${encodeURIComponent('[id,link_rewrite,active]')}&output_format=JSON`;
        const lr = await fetch(listUrl, { headers });
        if (!lr.ok) {
          res.status(502).json({ error: `PrestaShop API error ${lr.status}` });
          return;
        }
        const ldata = await lr.json();
        const rows = Array.isArray(ldata.content_management_system) ? ldata.content_management_system : [];
        const match = rows.find(p => firstLangValue(p.link_rewrite, '') === slug && String(p.active) !== '0');
        if (!match) {
          res.status(404).json({ error: 'Página no encontrada' });
          return;
        }
        targetId = match.id;
      }

      const fields = '[id,meta_title,meta_description,content,link_rewrite,active]';
      const url = `${baseUrl}/api/content_management_system/${targetId}?display=${encodeURIComponent(fields)}&output_format=JSON`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        res.status(502).json({ error: `PrestaShop API error ${r.status}` });
        return;
      }
      const data = await r.json();
      const page = data.content_management_system;
      if (!page || String(page.active) === '0') {
        res.status(404).json({ error: 'Página no encontrada' });
        return;
      }

      const title = firstLangValue(page.meta_title, 'Página');
      let content = firstLangValue(page.content, '');
      if (!content.trim()) content = fallbackContentFor(title);

      res.status(200).json({
        page: {
          id: page.id,
          title,
          description: firstLangValue(page.meta_description, ''),
          content,
          slug: firstLangValue(page.link_rewrite, '')
        }
      });
      return;
    }

    const fields = '[id,meta_title,link_rewrite,active]';
    const url = `${baseUrl}/api/content_management_system?display=${encodeURIComponent(fields)}&filter[active]=1&output_format=JSON`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      res.status(502).json({ error: `PrestaShop API error ${r.status}` });
      return;
    }
    const data = await r.json();
    const rows = Array.isArray(data.content_management_system) ? data.content_management_system : [];
    let pages = rows
      .filter(p => String(p.active) !== '0')
      .map(p => ({
        id: p.id,
        title: firstLangValue(p.meta_title, 'Página'),
        slug: firstLangValue(p.link_rewrite, '')
      }))
      .filter(p => p.slug);

    if (all) {
      pages = pages.map(p => ({ ...p, inFooter: FOOTER_PAGE_KEYWORDS.some(kw => normalize(p.title).includes(kw)) }));
    } else {
      pages = pages.filter(p => FOOTER_PAGE_KEYWORDS.some(kw => normalize(p.title).includes(kw)));
    }

    res.status(200).json({ pages });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar API de Páginas PrestaShop', detail: String(err) });
  }
};
