// Reglas de título y texto de respaldo para las páginas CMS que no están
// migradas al repo (ver api/paginas.js): las que se copiaron de PrestaShop a
// ps_cms_paginas o solo existen en data/cms-legacy-index.json.

// Palabras clave (sin acentos, en minúsculas) que debe contener el título
// de una página para mostrarse en el footer de la tienda.
const FOOTER_PAGE_KEYWORDS = ['envio gratis', 'privacidad'];

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
// lo revise y lo edite.
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

// Contenido genérico para las páginas de aterrizaje tipo "Accesorios neon
// para fiestas CDMX" / "Cosas para fiestas Puebla" (SEO programático por
// ciudad/categoría) cuando PrestaShop tiene la página creada pero sin
// redactar. Usa el propio título como base ("su página original") y datos
// reales de la tienda; el grid de productos relacionados se agrega aparte
// en el front (ver renderCmsRelatedProducts en index.html).
function genericFallbackContent(title) {
  return `
    <p>Encuentra <b>${title}</b> en <b>Mi Fiestashop</b>: artículos de fiesta, globos, decoración, accesorios y pirotecnia fría al mayoreo y menudeo, con envío a toda la República Mexicana.</p>
    <ul>
      <li>Envío gratis en compras mayores a $1,500 MXN.</li>
      <li>Recolección sin costo en nuestras sucursales de Ciudad de México, Querétaro y Puebla.</li>
      <li>Atención y asesoría personalizada por WhatsApp.</li>
    </ul>
    <p>Explora los productos relacionados con <b>${title}</b> más abajo, o escríbenos por WhatsApp al <a href="https://wa.me/525612622146">561 262 2146</a> si buscas algo en específico.</p>
  `;
}

// Algunas páginas (sobre todo las de aterrizaje por ciudad/categoría creadas
// en lote) tienen el link_rewrite bien puesto pero el meta_title vacío en
// PrestaShop. En vez de mostrar el título genérico "Página", se arma un
// título legible a partir del propio slug.
function titleFromSlug(slug) {
  const words = String(slug || '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return 'Página';
  return words.replace(/\b\w/g, c => c.toUpperCase());
}

// Algunas páginas también tienen el meta_title lleno pero con el valor
// genérico "Página" tal cual (dejado por error al crear la página). Se
// trata igual que si estuviera vacío, para no mostrar ese texto sin
// sentido como título real.
function isGenericTitle(title) {
  return !title || normalize(title).trim() === 'pagina';
}

function fallbackContentFor(title) {
  const norm = normalize(title);
  const match = FALLBACK_CONTENT.find(f => norm.includes(f.keyword));
  return match ? match.html : genericFallbackContent(title);
}

module.exports = { normalize, titleFromSlug, isGenericTitle, fallbackContentFor, FOOTER_PAGE_KEYWORDS };
