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

## 2026-09-26

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
2. **Slugs de páginas CMS:** en la tienda vieja `/content/98-articulos-pata-batucada-en-cdmx` redirige (301) a `/content/288-...`; en Vercel esa dirección da 404 (solo existe la id 288). Decidir si se agregan redirecciones por slug.
3. **Paquetes de batucada:** solo existe el Estándar; no hay Jr ni VIP en el catálogo.
4. **Meta:** con transferencia o efectivo, Purchase se reporta al crear el pedido, antes de confirmar el pago. Solo Mercado Pago se reporta desde el servidor.
5. Fotos de la galería de XV años: miden 736 px de ancho; con originales más grandes se verían mejor en el visor.
6. Las páginas de boda y batucada siguen recortando la foto del hero (solo se corrigió XV años y mayoreo).
7. "Acceso Administrativo" sigue como enlace de texto en el pie de página de la tienda.
