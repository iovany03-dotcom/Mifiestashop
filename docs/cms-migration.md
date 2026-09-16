# Migración: Publicidad Facebook y Google Ads

## Alcance confirmado

Se migran únicamente las categorías originales de PrestaShop:

- **33 — PUBLICIDAD FACEBOOK:** 26 páginas activas.
- **34 — PUBLICIDAD GOOGLE ADS:** 113 páginas activas.

Total: **139 páginas, 127 slugs distintos y 393 rutas**. La pertenencia se verificó en las rutas de navegación de las páginas originales; cada registro conserva categoryId y categoryName.

Quedan fuera las 13 páginas de categorías principales, información, contacto, mayoreo general, descuentos y políticas (IDs 9, 11, 12 y 412–421). Conservan el renderer y la API originales de PrestaShop. No se generan HTML ni rutas nuevas para ellas.

## Rutas y contenido

Se conservan títulos y slugs exactos, incluyendo errores de escritura y guiones finales. Cada página mantiene /content/ID-slug; los accesos /slug y /pagina/slug siguen disponibles. Los slugs repetidos se distinguen por ID; los accesos sin ID eligen el primero, como la API anterior.

El diseño sigue la referencia de artículos para boda, con Fredoka, Poppins, turquesa, rosa, violeta y botones naranjas. El título determina la temática del texto y catálogo. Las páginas sin ubicación original no reciben una sucursal. Se corrigen 15 mapas que no correspondían a la ciudad del título utilizando ubicaciones verificadas en las páginas originales.

Las imágenes CMS disponibles están guardadas en img/cms. Las imágenes originales que no respondían se omiten o se sustituyen por una imagen existente de su temática. Los registros originales sin texto (293, 353, 354, 370 y 403) mantienen título y temática sin inventar una dirección.

Las tres páginas de registro VIP pertenecen a Facebook y conservan sus endpoints y destinos originales. Las comprobaciones finales simulan fetch y bloquean el servicio externo, sin enviar registros. El comportamiento original no-cors no permite confirmar la recepción del servicio.

## Mantenimiento y pruebas

data/cms-pages.json contiene la fuente y categoría; scripts/cms-content.cjs construye el contenido; scripts/cms-themes.cjs define las temáticas; scripts/build-cms.cjs genera HTML, metadatos, rutas, API y sitemap.

Ejecutar npm ci, npm run build:cms y npm run test:cms. Versionar los resultados generados antes de desplegar. La generación es local y no consulta servicios externos.

Las pruebas recorren todas las páginas incluidas y comprueban títulos, rutas, slugs duplicados, direcciones, temáticas, imágenes, API, sitemap, formularios y sintaxis. La revisión móvil inicial cubrió las 152 páginas del conjunto mayor; las 139 seleccionadas forman parte de esa revisión. Se agregan verificaciones específicas de las categorías y de la conservación del comportamiento de las páginas excluidas.

## Independencia de PrestaShop

Las 139 páginas sirven HTML, contenido, logo, imágenes y catálogo temático desde el despliegue de Vercel. `data/cms-products.json` contiene 79 productos seleccionados con imágenes locales en `img/cms-products`. Las tarjetas no publican precios copiados que puedan quedar desactualizados; enlazan a la ficha de producto del sistema para consultar la compra.

El inventario del administrador combina las páginas migradas con un índice local de las 13 páginas pendientes, sin consultar PrestaShop. Las migradas muestran EN SISTEMA y Ver en sistema. El contenido de las páginas excluidas sigue utilizando la integración anterior al abrirlas.

Validación: 13 pruebas automatizadas aprobadas y carga de la página de boda de Querétaro en navegador con PrestaShop bloqueado: ocho productos, ninguna imagen rota y ninguna petición a ese dominio. Los mapas y registros VIP conservan sus servicios externos originales; el catálogo general y la compra quedan fuera de esta migración de páginas.
