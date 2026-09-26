// Galería al final de las páginas de XV años. Usa las mismas clases que la
// galería de boda (.celebration-gallery / .gallery-photo / .gallery-dialog),
// así el visor de assets/cms-gallery.js ya la maneja sin cambios.
const PHOTOS = [
  ['glow-accesorios.webp', 941, 1672, 'Invitados con pulseras, collares y bastones luminosos de Mi Fiesta Shop en una fiesta de XV años'],
  ['lentes-led-grupo.webp', 940, 1672, 'Grupo de invitados con lentes LED de Mi Fiesta Shop en una fiesta de XV años'],
  ['galeria-01.jpg', 736, 981, 'Grupo de amigos con lentes de sol verde neón y pulseras luminosas en una fiesta'],
  ['galeria-02.jpg', 981, 736, 'Amigas con collares verdes, lentes de colores y coronas de flores en una fiesta'],
  ['galeria-03.jpg', 736, 981, 'Pista de baile con luces LED y globos largos en un salón de XV años'],
  ['galeria-04.jpg', 736, 920, 'Quinceañera con vestido verde y robots LED luminosos'],
  ['galeria-05.jpg', 736, 1308, 'Quinceañera con lentes LED, corona y globos largos rodeada de invitados'],
  ['galeria-06.jpg', 736, 981, 'Fiesta de XV años con burbujas, conos luminosos y bastones de espuma'],
  ['galeria-07.jpg', 736, 981, 'Invitados con lentes de neón y pulseras brillantes en la oscuridad'],
  ['galeria-08.jpg', 736, 981, 'Invitada con collar de flores y lentes sobre una pista de baile iluminada']
];

function xvGalleryHtml() {
  const buttons = PHOTOS.map(([file, w, h, alt], i) =>
    '<button type="button" class="gallery-photo" aria-label="Ampliar foto ' + (i + 1) + '"><img src="/img/cms/xv-anos/' + file + '" alt="' + alt + '" loading="lazy" width="' + w + '" height="' + h + '"></button>'
  ).join('');
  return '<section class="xv-gallery wrap" aria-label="Galería de XV años"><div class="section-heading"><div><h2>Galería de XV años</h2><p>Así se viven los XV con accesorios luminosos de Mi Fiesta Shop.</p></div></div><div class="celebration-gallery">' + buttons + '</div><dialog class="gallery-dialog" aria-label="Galería de XV años"><button type="button" class="gallery-close" aria-label="Cerrar">×</button><button type="button" class="gallery-prev" aria-label="Foto anterior">‹</button><img src="/img/cms/xv-anos/' + PHOTOS[0][0] + '" alt="' + PHOTOS[0][3] + '"><button type="button" class="gallery-next" aria-label="Foto siguiente">›</button><p class="gallery-count" aria-live="polite"></p></dialog></section>';
}

module.exports = { xvGalleryHtml };
