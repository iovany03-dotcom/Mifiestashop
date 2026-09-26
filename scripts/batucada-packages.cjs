// Paquetes de batucada en las páginas CMS que no son de boda, XV años ni neón
// (esas tres ya traen sus propios paquetes Jr/Estándar/VIP). Muestra el
// precio y la lista de artículos reales de cada paquete (api/promo-paquetes.js,
// dibujado por assets/cms-promo-pricing.js) en lugar de las tarjetas de
// productos de la sección de promociones.
//
// - 83553: "Promo Batucada Estandar" (PrestaShop).
// - 10790464092173: "Promo Batucada VIP", producto propio en catalogo_productos
//   con 30 de los productos más vendidos; su precio ya trae el 15% de
//   descuento ($2,000 normal -> $1,700) y supera los $1,500 del envío gratis.
const PACKAGES = [
  { id: 83553, tier: 'Estándar' },
  { id: 10790464092173, tier: 'VIP', discount: 15 }
];
const HEADING = 'Paquetes de batucada';
const OWN_PACKAGES_THEMES = ['boda', 'xv', 'neon'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function usesBatucadaPackages(p) {
  return !OWN_PACKAGES_THEMES.includes(p.theme) && p.theme !== 'informacion' && !p.vip;
}

function batucadaPricingHtml() {
  return '<div id="cms-promo-pricing" class="promo-pricing-grid" style="max-width:760px;margin:0 auto" data-packages="' + esc(JSON.stringify(PACKAGES)) + '" aria-live="polite"></div>';
}

module.exports = { usesBatucadaPackages, batucadaPricingHtml, HEADING, PACKAGES, OWN_PACKAGES_THEMES };
