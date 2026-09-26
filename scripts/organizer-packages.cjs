// Páginas de organizadores de eventos: en lugar de las tarjetas de productos
// de la sección de promociones, muestran el paquete de batucada escrito
// (precio y lista de artículos reales, tomados de PrestaShop por id con
// api/promo-paquetes.js y dibujados por assets/cms-promo-pricing.js).
const ORGANIZER_PACKAGES = [{ id: 83553, tier: 'Estándar' }];
const HEADING = 'Paquetes de batucada';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isOrganizerPage(p) {
  return p.theme === 'mayoreo' && /organizador/i.test(p.title || '');
}

function organizerPricingHtml() {
  return '<div id="cms-promo-pricing" class="promo-pricing-grid" style="max-width:440px;margin:0 auto" data-packages="' + esc(JSON.stringify(ORGANIZER_PACKAGES)) + '" aria-live="polite"></div>';
}

module.exports = { isOrganizerPage, organizerPricingHtml, HEADING };
