# Páginas CMS migradas a Vercel

## Alcance

Se importaron las 152 páginas activas devueltas por el CMS el 15 de septiembre de 2026. Son 140 slugs distintos. Los títulos y slugs se conservan exactamente, incluidos los guiones finales, errores de escritura y duplicados.

Cada página tiene su ruta original `/content/ID-slug`. Las rutas `/<slug>` y `/pagina/<slug>` funcionan como accesos alternativos. Cuando hay un slug repetido, estos accesos apuntan al primer ID, igual que la API anterior; las rutas originales siguen distinguiendo todas las versiones.

## Contenido y presentación

- HTML estático con H1, descripción, URL canónica, Open Graph y datos estructurados propios. El contenido CMS ya no necesita la API de PrestaShop para mostrarse.
- Diseño basado en la referencia de artículos para boda: Fredoka y Poppins, turquesa, rosa, violeta y botones naranjas. Productos relacionados según el tema del título.
- Las páginas sin ubicación en su contenido original no reciben una sucursal por defecto. Se conserva la ubicación existente y se corrigen 15 mapas cuya ciudad no correspondía al título, usando mapas verificados de la sucursal correcta. Contacto conserva sus cuatro ubicaciones.
- Las imágenes CMS disponibles se guardan en `img/cms`. Los originales que no estaban disponibles se omiten o se sustituyen por una imagen existente de la misma temática. El registro de descargas está en `data/cms-assets.json`.
- Se reconstruyen los formularios VIP de los IDs 294, 295 y 296 con sus endpoints y destinos originales. Conservan el comportamiento `no-cors`; la respuesta opaca del servicio original no permite confirmar la recepción. Las pruebas interceptan la solicitud y no envían registros ni cupones.
- Los enlaces de cuatro productos antiguos se actualizan con los IDs del catálogo actual. Los slugs CMS no se alteran.
- Se conserva el texto informativo y legal original. Las plantillas comerciales eliminan titulares duplicados, textos de ejemplo y estilos/scripts del constructor antiguo; las reseñas se conservan como citas y las descripciones comerciales corresponden al tema de la página.

## Particularidades de la fuente

- Los IDs 413, 414, 415 y 416 devolvían 404 en la web pública, aunque el CMS los listaba activos. Se conserva el contenido que sí devolvía la API.
- Los IDs 293, 353, 354, 370, 403 y 419 no contenían texto original o estaban vacíos. Se conserva su identidad y temática sin importar las direcciones que la API antigua inventaba como respaldo. El ID 419 tenía una imagen promocional.
- El inventario activo incluye páginas antiguas de plantilla (bicicletas, hogar y herramientas). Se preservan sus temas y rutas, sin convertirlas en páginas de bodas.
- El catálogo de productos sigue consultándose en vivo mediante la API existente. Si no hay productos de la temática, se muestra el estado vacío; nunca se rellena con productos de otro tema.

## Mantenimiento

`data/cms-pages.json` conserva el contenido fuente y la procedencia de cada página. `scripts/cms-content.cjs` construye el modelo, aplica las reglas de ubicación y limpia el HTML. `scripts/cms-themes.cjs` define las temáticas. `scripts/build-cms.cjs` genera los HTML, las rutas y los registros para la API/sitemap.

```sh
npm ci
npm run build:cms
npm run test:cms
```

Después de editar datos, plantillas o reglas, regenerar y versionar los archivos resultantes de `cms-pages`, `data/cms-runtime.json`, `data/cms-manifest.json` y `vercel.json`. La generación no consulta servicios externos. Vercel sirve los archivos ya generados y las funciones existentes.

## Verificación

Pruebas automatizadas de todos los IDs, títulos, rutas, slugs repetidos, direcciones, temáticas, imágenes locales, API CMS, sitemap, formularios, sanitización y sintaxis JavaScript. Revisión de las 152 páginas a 390 px de ancho, más revisión visual de bodas, neón, sombreros, Puebla, globos, mayoreo y políticas. La prueba del catálogo usa datos públicos del catálogo y verifica tanto productos pertinentes como ausencia de coincidencias.
