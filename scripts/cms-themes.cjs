// The title determines the subject. A city never selects the subject or adds a store.
const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const THEMES = {
  boda: { label: 'Bodas', query: 'boda', terms: ['boda', 'novio', 'novia', 'matrimonio'], intro: 'Dale tu estilo a la celebración. Encuentra accesorios para los novios, recuerdos y artículos para llenar de color la pista de tu boda.', tags: ['Accesorios para novios', 'Recuerdos', 'Batucada de boda'], promoPackages: [{id:83589,tier:'Jr'},{id:83552,tier:'Estándar'}] },
  xv: { label: 'XV años', query: 'xv', terms: ['xv', 'quince', 'quinceanera'], intro: 'Haz que tus XV años se sientan como tú. Combina accesorios, luminosos y detalles para compartir una noche especial con tus invitados.', tags: ['XV años', 'Accesorios para la fiesta', 'Luminosos'], promoPackages: [{id:83554,tier:'Jr'},{id:83549,tier:'Estándar'},{id:83555,tier:'VIP'}] },
  pintura: { label: 'Pintura neón', query: 'pintura', terms: ['pintura', 'maquillaje'], intro: 'Ponle color a tu fiesta neón. Explora pinturas y maquillaje para crear una temática fluorescente con tus invitados.', tags: ['Pintura neón', 'Maquillaje', 'Color para tu fiesta'] },
  polvo: { label: 'Polvo neón', query: 'polvo', terms: ['polvo'], intro: 'El color es el protagonista de tu celebración. Consulta las opciones de polvo neón y sus características antes de elegir para tu evento.', tags: ['Polvo neón', 'Fiesta de color', 'Temática fluorescente'] },
  neon: { label: 'Fiesta neón', query: 'neon', terms: ['neon', 'fluor', 'fluorescente', 'luminos', 'cyalume', 'led', 'glow'], intro: 'Llena tu fiesta de color con accesorios neón, luminosos y detalles fluorescentes. Combina tus favoritos para dar vida a tu propia glow party.', tags: ['Neón', 'Luminosos', 'Accesorios fluorescentes'], promoPackages: [{id:83547,tier:'Jr'},{id:83546,tier:'Estándar'},{id:83548,tier:'VIP'}] },
  sombreros: { label: 'Sombreros para fiesta', query: 'sombrero', terms: ['sombrero', 'gorro', 'bombin'], intro: 'Sombreros de espuma, gorros y diseños divertidos para darle personalidad a tu fiesta. Elige los accesorios que van con tu celebración.', tags: ['Sombreros locos', 'Gorros', 'Hule espuma'] },
  globos: { label: 'Globos', query: 'globo', terms: ['globo'], intro: 'Dale forma a tu decoración con globos. Explora colores, materiales y diseños para encontrar los que van con tu celebración.', tags: ['Látex', 'Metálicos', 'Decoración con globos'] },
  cumpleanos: { label: 'Cumpleaños', query: 'cumple', terms: ['cumple', 'birthday', 'pastel', 'vela'], intro: 'Celebra un año más con tu propio estilo. Encuentra decoración y accesorios para preparar un cumpleaños lleno de color y buenos momentos.', tags: ['Cumpleaños', 'Decoración', 'Accesorios para celebrar'] },
  infantil: { label: 'Decoración infantil', query: 'infantil', terms: ['infantil', 'nino', 'nina', 'personaje', 'globo'], intro: 'Crea una celebración para los más pequeños con decoración, globos y detalles que acompañen su temática favorita.', tags: ['Fiesta infantil', 'Decoración', 'Globos'] },
  batucada: { label: 'Batucada', query: 'batucada', terms: ['batucada', 'corneta', 'mechudo', 'salchicha', 'peluca', 'hawaian', 'antifaz', 'luminos', 'inflable'], intro: 'Que siga la fiesta. Arma tu batucada con accesorios para repartir, sombreros, lentes y luminosos que acompañen cada canción.', tags: ['Batucada', 'Accesorios para bailar', 'Luminosos'] },
  mayoreo: { label: 'Fiestas al mayoreo', query: 'fiesta', terms: ['fiesta', 'globo', 'batucada', 'sombrero', 'antifaz', 'neon', 'luminos'], intro: 'Encuentra artículos para surtir tu negocio o preparar tus eventos. Revisa las opciones de mayoreo y elige los productos que necesitas.', tags: ['Artículos al mayoreo', 'Negocios', 'Organizadores de eventos'] },
  recuerdos: { label: 'Recuerdos para fiesta', query: 'recuerdo', terms: ['recuerdo', 'souvenir', 'vaso', 'llavero'], intro: 'Elige detalles para compartir con tus invitados y llevarse un recuerdo de la celebración. Consulta las opciones para tu evento.', tags: ['Recuerdos', 'Souvenirs', 'Detalles para invitados'] },
  fiesta: { label: 'Artículos para fiesta', query: 'fiesta', terms: ['fiesta', 'globo', 'batucada', 'sombrero', 'antifaz', 'neon', 'luminos'], intro: 'Todo empieza con una idea para celebrar. Encuentra accesorios, decoración y artículos de fiesta para darle tu estilo a cada momento.', tags: ['Decoración', 'Accesorios', 'Artículos para fiesta'] },
  informacion: { label: 'Información', query: '', terms: [], intro: '', tags: [] },
  bicicletas: { label: 'Bicicletas', query: 'bicicleta', terms: ['bicicleta'], intro: '', tags: [] },
  hogar: { label: 'Hogar', query: 'hogar', terms: ['hogar'], intro: '', tags: [] },
  herramientas: { label: 'Herramientas', query: 'herramienta', terms: ['herramienta'], intro: '', tags: [] }
};
function themeFor(page) {
  const t = normalize(page.title);
  if (/bicicleta/.test(t)) return 'bicicletas';
  if (/^hogar$/.test(t)) return 'hogar';
  if (/herramienta/.test(t)) return 'herramientas';
  if (/registro|politica|aviso|terminos|sobre nosotros|pago seguro|^envio$|contactanos/.test(t)) return 'informacion';
  if (/sombrero|gorro/.test(t)) return 'sombreros';
  if (/boda/.test(t)) return 'boda';
  if (/xv|quince/.test(t)) return 'xv';
  if (/pintura/.test(t)) return 'pintura';
  if (/polvo/.test(t)) return 'polvo';
  if (/neon|fluor|glow/.test(t)) return 'neon';
  if (/globo/.test(t)) return 'globos';
  if (/cumple/.test(t)) return 'cumpleanos';
  if (/infantil/.test(t)) return 'infantil';
  if (/batucada/.test(t)) return 'batucada';
  if (/souvenir|recuerdo/.test(t)) return 'recuerdos';
  if (/mayor|prove[d]?or|organizad/.test(t)) return 'mayoreo';
  return 'fiesta';
}
module.exports = { normalize, THEMES, themeFor };
