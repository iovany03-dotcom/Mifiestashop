# Migración completa — preparación del 17 de septiembre de 2026

## Estado

Código preparado en `codex/complete-prestashop-migration`, integrado con `b86ee22`.
Las cuatro tablas privadas ya están creadas y el backfill de direcciones está
en curso. Todavía no se ha desplegado el código. Los interruptores
`PS_NATIVE_CUSTOMERS` y `PS_NATIVE_COMMERCE` permanecen desactivados por defecto.
No activar sin completar la conciliación descrita abajo.

Auditoría real de Supabase: 9,196 clientes; 0 con teléfono, RFC o dirección.
Existen 1,067 productos descriptivos y 3,001 pedidos. Estos conteos no prueban
que el origen esté completamente importado.

## Preparación y ejecución

1. Habilitar GET en `addresses` para la clave de integración de PrestaShop.
   Confirmar también `products`, `specific_prices`, `stock_availables`, `orders`,
   `order_details`, `customers`, `shops` y `order_states`.
2. Ejecutar `docs/prestashop-storage-setup.sql` como propietario de la base.
   Son cuatro tablas nuevas con RLS y acceso exclusivo de `service_role`.
   No se amplían las políticas públicas de las tablas existentes.
3. Configurar `PS_API_KEY` y `SUPABASE_SERVICE_ROLE_KEY` en el entorno del proceso
   y en el servidor Vercel. Nunca en HTML, archivos versionados ni parámetros URL.
4. Ejecutar `npm run migrate:prestashop`. También acepta dominios concretos:
   `npm run migrate:prestashop -- direcciones pedidos_historicos`.
   No ejecutar dos importadores del mismo dominio simultáneamente.
5. Repetir los dominios que informen `complete:false`. Los cursores se guardan
   después de cada página confirmada. Un fallo de permisos no se interpreta
   como una colección vacía. El histórico empieza desde el principio y avanza
   sin la ventana de 3,000; la sincronización reciente conserva esa ventana.
6. Comparar los conjuntos completos de IDs del origen y destino, no solo su
   máximo. Confirmar direcciones por cliente, DNI y VAT sin inventar RFC faltantes;
   todas las líneas de pedidos; precios; condiciones de mayoreo; stock por tienda
   y almacén. Repetir el cotejo después del último movimiento en PrestaShop.
7. Desplegar primero a preview. Para clientes activar `PS_NATIVE_CUSTOMERS=1`;
   para productos, sitemap, stock y checkout activar `PS_NATIVE_COMMERCE=1`.
   Probar con PrestaShop inaccesible y con sesiones administrativas válidas e
   inválidas antes de cambiar producción.

`CRON_SECRET` es obligatorio para los nuevos dominios invocados desde HTTP.
El importador de línea de comandos es preferible para el backfill inicial.
No está programada la actualización de los nuevos dominios: se debe coordinar
el último lote y la transición de escrituras para evitar que el origen vuelva
a sobrescribir movimientos hechos en el destino.

## Comportamiento

- Se conservan todas las direcciones, incluidas las históricas eliminadas,
  en una tabla privada. La API autenticada muestra las activas, ordenadas por
  fecha; RFC y teléfono pueden proceder de otra dirección activa del cliente.
  `dni` y `vat_number` se conservan separados. Los campos no se copian a
  `ps_clientes`, cuya política existente es pública.
- El catálogo descriptivo y sus imágenes conservan `productos_migrados`;
  las nuevas tablas preservan los datos comerciales completos del origen.
  El cálculo de mayoreo muestra reglas del grupo 60, vigentes y sin restricciones
  individuales. Las reducciones de importe con impuesto requieren todavía
  conciliar el contexto fiscal; no se muestra un precio no verificado.
- El checkout conserva la política previa de precio minorista, validada en
  servidor. No se aplica mayoreo a una identidad de grupo enviada por el cliente.
  El stock se valida en la tienda 50 (Mi Fiestashop); no hay reserva atómica nueva de inventario.
  La política de impuestos, descuentos de checkout y reserva concurrente requiere
  validación real antes de activar el cambio comercial.
- Las diez páginas 412–421 provienen de la exportación local del 15 de septiembre.
  Se verificó que las diez responden en la API vigente el día 17, pero la descarga
  de refresco quedó bloqueada antes de guardarse. La imagen de descuentos de 419
  respondió 404; se omite. Envíos y devoluciones usan sus banners ya archivados.
- La API de páginas sirve las 149 páginas sin PrestaShop. Se preservan títulos,
  slugs y rutas por ID. Las categorías ocultas 9, 11 y 12 siguen ocultas.
- El sitemap ya pagina hasta el final y devuelve 503 ante una consulta incompleta.
  Los enlaces públicos al catálogo y los paquetes llevan a rutas locales.

## Pruebas

`npm run build:cms`, `npm run test:cms`, `npm run test:migration`.
Las pruebas usan datos sintéticos y bloquean escrituras externas. Pasar pruebas
locales no equivale a haber importado o desplegado datos reales.

## Accesos y alcance de la importación

GET de direcciones está confirmado. El navegador permite acceder a PrestaShop
y Vercel; la variable SUPABASE_SERVICE_ROLE_KEY ya existe en producción.
La clave CHAT GPT se utiliza únicamente en memoria del importador autorizado.

El recurso addresses no aísla las tiendas del origen. Antes de guardar una
dirección se exige que id_customer pertenezca al directorio ps_clientes.
Una primera copia de 5,750 direcciones ajenas quedó en la tabla privada y su
retirada está pendiente de aprobación explícita; ninguna se vincula con los
clientes de Mi Fiestashop ni aparece en el sitio. No activar la migración
hasta completar esta limpieza y conciliar todos los clientes.

## Inventario avanzado — 18 de septiembre de 2026

Se copiaron y conciliaron los 236 documentos visibles del módulo de inventario
avanzado: 1,352 partidas y 732 eventos de historial. Dos formularios sin productos
contenían una fila vacía de interfaz, que se excluyó después de verificarla.
Las cantidades de partidas coinciden con los contadores de los 236 documentos.
Se preservan folios, almacenes, responsables, estados, observaciones y eventos.
Las fechas y responsables se toman del listado y del historial, porque los campos
editables de algunos formularios mostraban valores predeterminados de la sesión.

`docs/prestashop-inventory-history-setup.sql` crea dos tablas privadas con RLS.
`ps_inventory_documents` contiene los documentos importados; la tabla separada
`ps_inventory_movements` sigue pendiente de carga. Los movimientos históricos
no se insertan en `pos_stock_moves`, porque alterarían otra vez el stock actual.

`POST /api/inventory-history` exige la sesión administrativa existente y pagina
resúmenes de 50 documentos. Con `?id=` devuelve las partidas y eventos originales.
El modal de movimientos incorpora la consulta y búsqueda del historial importado.
Esta interfaz está preparada en la rama de migración; todavía no está en producción.
La importación de documentos no equivale a migrar el registro general de movimientos,
ni implementa aprobación o aplicación de borradores del módulo original.

La generación correcta de direcciones contiene 5,768 registros de 5,107 clientes.
Se requiere conciliar los clientes agregados durante la migración y resolver el
lote ajeno pendiente antes de activar el directorio nativo.
