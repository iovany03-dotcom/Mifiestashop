# Bitácora de Mi Fiestashop

Registro de lo esencial: qué se hizo, por qué, y qué queda pendiente. Lo más nuevo va arriba.

**Producción:** https://mifiestashop.vercel.app · **Repo:** `iovany03-dotcom/Mifiestashop` (rama `main` despliega sola en Vercel)
**Vercel:** proyecto `prj_cQ074XhG9byErEH1yd6ABC7KHngW`, equipo `team_zSNK72pvKViOUhFytG6KzAOv` · **Supabase:** `iuoirslxjcyarvmrqyjd`

## Reglas y cuidados que conviene recordar

- **Las páginas CMS (`cms-pages/`, `data/cms-runtime.json`) están publicadas a mano encima de una construcción vieja.** No correr `scripts/build-cms.cjs` completo sin revisar el diff: la fuente actual ya no genera cosas que sí traen las páginas publicadas (por ejemplo el aviso de mantenimiento) y reescribiría todo. Los cambios recientes se aplicaron con parches de una línea por página y también se dejaron en la plantilla del generador.
- Al cambiar `assets/cms.css` hay que actualizar el `?v=` de `cms.css` en todas las páginas (hash sha256 de 12 caracteres del archivo con saltos de línea LF).
- Archivos con saltos de línea CRLF en Windows: los reemplazos masivos con `node -e` fallan; usar la herramienta de edición o comparar con `git diff --ignore-space-at-eol`.
- La tabla `ps_inventory_movements` y `ps_inventory_documents` son privadas: solo escribe la llave `service_role` (`SUPABASE_SERVICE_ROLE_KEY`). La constante `serviceKey` de `api/cron-sync-prestashop.js` es en realidad la llave anónima.
- Variables de entorno en Vercel (solo nombres): `MP_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `META_CAPI_TOKEN` (solo Production), `PS_API_KEY`, `PS_BASE_URL`, `SKYDROPX_API_KEY`, `SKYDROPX_API_SECRET`, `SMTP_*`. Las variables nuevas solo aplican a despliegues nuevos.

## 2026-10-02

- **Ya no se depende solo de PrestaShop para las ventas** (segunda parte): (1) "Productos más vendidos" (`api/ventas-productos.js`) suma `pos_tickets` con la vista privada `pos_ventas_producto_mes` (se lee con la llave de servicio; si falta o falla, la respuesta trae `posIncluido:false` y `posError`); (2) los tickets del POS ahora guardan `product_id` en cada línea, y a los 83 anteriores se les recuperó cruzando con sus movimientos `venta_pos` (coincidían en orden y cantidad; unidades e ingresos cuadran); (3) "Ventas Mensuales Históricas" dejó la tabla fija (`HIST`, congelada en septiembre) y se calcula en vivo con `/api/ventas` desde marzo; (4) se corrigió que un mismo producto/mes en PrestaShop y POS se pisaba en vez de sumarse. **Siguen dependiendo de PrestaShop:** "Estados de pedidos confirmados" y "Stock por sucursal" (tablas fijas en `HIST`), y la lista de Pedidos ya mezcla tickets y pedidos de la tienda.
- **Ventas nuevas no aparecían en el Informe de Ventas ni en Estadísticas:** las ventas del POS propio se guardan en `pos_tickets`, pero esos dos lugares leían solo pedidos de PrestaShop (`ps_pedidos`), que dejaron de llegar a fines de septiembre (Puebla: último pedido 26-sep, con 25 tickets propios después). Ahora ambos suman `pos_tickets` (sin duplicar los que tengan `ps_order_id`): el informe en el navegador y `api/ventas.js` en el servidor (fechas en hora de México). **Pendiente conocido:** los tickets del POS no llegan a PrestaShop; los 83 tickets desde el 21-sep tienen `ps_sync_status='error'` (`POST /api/orders -> 500`), así que PrestaShop no descuenta su stock ni registra esas ventas.

- **Movimientos de inventario con borrador y aprobación** (modal "Movimientos & Traspasos"): el histórico ahora es el botón **Historial** (muestra "N por aprobar") y lista solo entradas, salidas y traspasos; las ventas y pedidos manuales se ven en "Movimientos de inventario" (Kardex). Cada movimiento se guarda como **borrador** (no toca el inventario; se puede editar o descartar) y debe **aprobarse**: al aprobar se aplica a `pos_stock_moves` y queda "Aprobado por X · fecha". Solo el administrador, o quien tenga el permiso nuevo "Aprobar movimientos de inventario", puede aprobar; la existencia se vuelve a comprobar al aprobar. Cada movimiento (también borradores y los anteriores) se descarga en **PDF** con firmas Elaboró/Aprobó. Corregir/Revertir siguen disponibles en los aprobados; "Corregir" ahora genera un borrador nuevo. Base de datos: tabla `mov_documentos` y funciones `rpc_mov_*` (SQL en `docs/supabase-movimientos-aprobacion.sql`); el nombre de quien captura y aprueba lo pone el servidor desde la sesión. Los movimientos hechos antes de este cambio aparecen sin registro de aprobación.
- **Informe de Ventas (admin):** tarjetas nuevas Total, Efectivo, Tarjeta y Salidas arriba de las gráficas. Las ventas siguen todos los filtros; las salidas de caja solo fechas y tienda/punto de venta (no tienen método de pago ni empleado de venta). Tarjeta suma "Débito / Crédito" con y sin acentos; la nota del Total avisa cuánto es transferencia/otros para que cuadre.
- **Estadísticas:** tarjeta "Ventas por tienda" (api/ventas.js devuelve `byStore`; la tienda es la caja/empleado del pedido: 225 CDMX Rumania, 226 Querétaro, 230 Puebla, 227 Atizapán; sin empleado = tienda en línea). (`81fd126`)
- **POS:** botón "Sacar como cotización" (PDF con jsPDF desde cdnjs; no genera ticket ni mueve inventario/caja). (`281899d`)
- **Páginas CMS:** tarjetas de producto como las de la tienda (SKU, precio en vivo con `/api/productos?ids=`, "Ver producto"). (`01c451d`)
- **Paquetes de batucada** (Estándar 83553 y **Promo Batucada VIP** id 10790464092173, $1,700 = $2,000 con 15% de descuento, 30 productos más vendidos) en las 94 páginas que no son boda/XV/neón/informativas/VIP; el VIP vive en `catalogo_productos` y las APIs lo completan cuando PrestaShop no lo tiene. Bloque en `scripts/batucada-packages.cjs`. (`d2a1ddc`)

## 2026-09-26

- **Redirección por nombre en páginas CMS:** como hacía PrestaShop, `/content/<id>-<slug>` con un id que no existe redirige (301) a la primera página con ese slug; si el slug tampoco existe, 404. Los ids reales no se tocan (rutas exactas en `vercel.json`; la regla va al final). Función `api/cms-redirect.js`; pruebas en `tests/cms.test.cjs`. Auditoría previa: en la tienda vieja las 139 páginas redirigen por nombre, y 12 (slugs repetidos: 327, 328, 354, 367, 369, 370, 385, 395, 396, 397, 408, 409) mandan a otra página; en Vercel esas 12 abren su propia página.
- **Página 288:** el título decía "pata" y ahora dice "Articulos para batucada en CDMX" (h1, title, og, JSON-LD, enlaces relacionados y datos). La dirección se dejó `/content/288-articulos-pata-batucada-en-cdmx` porque `articulos-para-batucada-en-cdmx` ya es el slug de la página 308.
- **Pruebas:** se corrigió la prueba del sitemap (faltaba el encabezado `host` desde el cambio de dominio dinámico); 19 pruebas de CMS y 7 de la API pasan.
- **POS:** no se puede cobrar sin caja abierta (aviso al abrir el cobro y al confirmar; la caja es por sucursal). Botón propio rojo "Cerrar Caja". (`9d92a72`, `e5011d0`)
- **Portal de clientes:** se quitó el botón "Acceso POS / Admin" y los iconos de los botones. El botón de notificaciones del admin ya no sale vacío. (`327b98b`, `8564636`)
- **Skydropx:** se bloquean Estafeta, Ninetynineminutes/99minutos y Paquetexpress "Nacional Sin Recolección". El filtro compara nombres sin acentos ni guiones (`api/skydropx-cotizar.js`). (`c9ff317`, `fc6b4c1`)
- **Formulario de producto:** se puede subir una foto desde el equipo; va al bucket público `assets/productos/` de Supabase y llena el campo de imagen. Una sola foto por producto. (`0465983`)
- **Páginas CMS:**
  - Botón "Ver más opiniones" bajo las reseñas, con enlace de Google Maps por sede: CDMX/general `t9gun227wXwa26Ff6`, Querétaro `ZKjUHHA1SSNaemxv8`, Puebla `Bs3YzM5CA2e39Guw9`. (`0d5aaa6`)
  - XV años: la foto del hero se ve completa (era vertical y se recortaba) y hay una galería de 10 fotos al final, con visor ampliable; el bloque vive en `scripts/xv-gallery.cjs`. (`e31e755`, `9d78e86`)
  - Mayoreo: la imagen de la máscara se cambió por la foto de fiesta (`img/cms/mayoreo-fiesta.webp`), páginas 291, 354 y 403. (`0ef57a7`)
  - Organizadores (283, 285, 286, 287, 291): la sección de promociones muestra el paquete escrito "Promo Batucada Estandar" (id 83553, $599); bloque en `scripts/organizer-packages.cjs`. (`d0ffe6f`)

## 2026-09-23 / 09-24

- **Meta Pixel:** revisión completa. PageView también al navegar dentro de la tienda, cola de eventos antes de cargar la configuración, AddToCart sin duplicados, y eventos Search, Contact y CompleteRegistration. (`e199135`)
- **Meta Conversions API:** las compras con Mercado Pago se reportan también desde el servidor (`lib/meta-capi.js`, `api/mp-webhook.js`), con el folio como `event_id` para que Meta deduplique con el navegador. Token validado con un evento de prueba (respuesta 200). Falta ver una compra real en Events Manager. (`dfe7206`, `28c6ce8`)
- **Movimientos de inventario:** se importan a `ps_inventory_movements` (modos `movimientos`, `movimientos_recientes` y `movimientos_desde` del cron). PrestaShop devuelve la clave `stock_mvts`, no acepta filtrar por almacén (se filtra en el código) y ~96 % de los movimientos son de otras tiendas. (`def93cb` a `67469e7`)
- **Emergencia PrestaShop:** se preserva el catálogo y se re-hospedan las fotos antes de apagarlo. (`f3a64a1`, `d60b94a`, `3ebfe55`)

## 2026-09-22

- **SEO:** middleware que reescribe el `<head>` real de productos y categorías, dominio dinámico en sitemap/robots/canonical, 404 real para ids inexistentes y JSON-LD de producto. Problemas resueltos por el camino: cuelgues, bucle 508, caché cruzada, `Content-Length` y `Content-Encoding` heredados. (`eff9849` a `c16315f`)
- **Stock:** el sync retoma donde se quedó; tarjeta "Stock Bajo por Sucursal" en el Dashboard.

## Pendientes y problemas conocidos

1. **Seguridad:** `/api/promo-paquetes` incluye en la URL de la imagen la llave de PrestaShop (`ws_key=...`); es pública. Regenerar la llave y servir las imágenes sin exponerla.
2. **Dirección de la página 288** conserva el error "pata" (`/content/288-articulos-pata-batucada-en-cdmx`). Corregirla exige elegir un slug que no choque con la 308 y redirigir el viejo.
3. **Paquetes de batucada:** solo existe el Estándar; no hay Jr ni VIP en el catálogo.
4. **Meta:** con transferencia o efectivo, Purchase se reporta al crear el pedido, antes de confirmar el pago. Solo Mercado Pago se reporta desde el servidor.
5. Fotos de la galería de XV años: miden 736 px de ancho; con originales más grandes se verían mejor en el visor.
6. Las páginas de boda y batucada siguen recortando la foto del hero (solo se corrigió XV años y mayoreo).
7. "Acceso Administrativo" sigue como enlace de texto en el pie de página de la tienda.
