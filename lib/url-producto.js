// URL pública de un producto, con el MISMO formato que PrestaShop:
//   /{categoria-por-defecto}/{id}-{link_rewrite}-{ean13}.html
// (sin "-{ean13}" si el producto no tiene código de barras; sin
// "{categoria}/" si no tiene categoría). Es la liga que Google ya tiene
// indexada, así que el sitio nuevo la conserva tal cual — ver middleware.js,
// que además redirige (301) cualquier otra variante a esta.
function productoPath({ id, linkRewrite, ean13, categoryRewrite }) {
  if (!id || !linkRewrite) return '';
  const ean = String(ean13 || '').trim();
  const cat = String(categoryRewrite || '').trim();
  return `${cat ? '/' + cat : ''}/${id}-${linkRewrite}${ean ? '-' + ean : ''}.html`;
}

module.exports = { productoPath };
