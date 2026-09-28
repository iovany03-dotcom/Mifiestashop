# Dominio mifiestashop.com → Vercel (y cómo regresar a PrestaShop)

El dominio y su DNS se quedan en **Cloudflare**. Solo cambian los registros
de `@` (mifiestashop.com) y `www`; todo lo demás (correo, `cdn1`, `cdn2`,
otros subdominios) se deja igual.

## Estado en Vercel (ya hecho)

Proyecto `mifiestashop`:

| Dominio | Uso |
|---|---|
| `www.mifiestashop.com` | Principal |
| `mifiestashop.com` | Redirige 308 → `www.mifiestashop.com` |
| `mifiestashop.vercel.app` | Sigue funcionando siempre (respaldo) |

Agregar los dominios en Vercel no cambia nada mientras el DNS siga
apuntando a PrestaShop.

## Qué depende todavía de PrestaShop

La tienda en línea, el checkout, el admin, los reportes y la API pública
**ya no consultan PrestaShop en vivo** (interruptor `PRESTASHOP_CONECTADO`,
apagado; ver `lib/prestashop.js`). Lo que sí depende:

1. **Las cajas de las tiendas físicas** venden en PrestaShop (instalación
   compartida con otras tiendas; Mi Fiestashop es la tienda 50).
2. **La copia automática PrestaShop → Supabase** (`api/cron-sync-prestashop.js`,
   crons en `vercel.json`): stock, productos, fotos, precios, categorías,
   almacenes, empleados, páginas, proveedores, clientes, pedidos, carritos y
   movimientos de inventario. Se conecta a `PS_BASE_URL` (variable en
   Vercel). **Si `PS_BASE_URL` es `https://www.mifiestashop.com`, deja de
   funcionar en cuanto `www` apunte a Vercel** — hay que cambiarla antes a
   un nombre que siga llegando a PrestaShop (ver abajo).
3. **Ventas del POS de esta app → PrestaShop** (`api/pos-sync-prestashop.js`):
   crea el pedido en PrestaShop después de cada venta, en segundo plano. Si
   falla, la venta se guarda igual en Supabase y queda marcada con error.
4. **Imágenes en `cdn1.mifiestashop.com` / `cdn2.mifiestashop.com`**: las
   usan las páginas "Contáctanos" y "Política de devolución". No tocar esos
   registros DNS.
5. Las existencias que muestra el admin = stock de PrestaShop (copiado) +
   movimientos propios de esta app.

## Antes de cambiar el DNS

1. **Respaldo de la zona**: Cloudflare → DNS → Records → *Import and Export*
   → *Export*. Guardar ese archivo y dárselo a Claude: se guarda en la tabla
   privada `respaldo_dns` de Supabase (no en este repo, que es público — la
   zona revela la IP real de PrestaShop detrás de Cloudflare).
2. **Nombre alterno para PrestaShop** (solo si `PS_BASE_URL` o las cajas usan
   `www.mifiestashop.com`): en Cloudflare crear p. ej. `ps.mifiestashop.com`
   con el mismo tipo/valor/proxy que tiene hoy `www`, y en PrestaShop
   (Multitienda → Mi Fiestashop → URL de la tienda) ponerlo como URL
   principal. Después cambiar `PS_BASE_URL` en Vercel a
   `https://ps.mifiestashop.com`, redesplegar y confirmar que
   `ps_sync_estado` sigue avanzando.

## Cambio (Cloudflare → DNS)

| Tipo | Nombre | Valor | Proxy |
|---|---|---|---|
| A | `@` | `76.76.21.21` | Solo DNS (nube gris) |
| CNAME | `www` | `cname.vercel-dns.com` | Solo DNS (nube gris) |

Si la página de Dominios del proyecto en Vercel muestra valores distintos,
usar los de Vercel. No tocar MX, TXT (SPF/DKIM/DMARC), `cdn1`, `cdn2` ni
otros registros.

Después del cambio: actualizar en `index.html` la etiqueta canonical y las
imágenes de redes sociales a `https://www.mifiestashop.com`.

## Regresar a PrestaShop (si algo sale mal)

1. En Cloudflare → DNS, volver a poner los registros `@` y `www` exactamente
   como estaban en el respaldo (mismo tipo, valor y **nube naranja** si
   estaban con proxy). Se refleja en minutos.
2. Si se había cambiado la URL principal de la tienda en PrestaShop a
   `ps.mifiestashop.com`, regresarla a `www.mifiestashop.com`.
3. Si se cambió `PS_BASE_URL`, regresarla al valor anterior y redesplegar.
4. No hace falta quitar los dominios de Vercel ni tocar el código: la tienda
   nueva sigue disponible en `mifiestashop.vercel.app`.
5. Si además se quiere que la tienda nueva vuelva a consultar PrestaShop en
   vivo: `PRESTASHOP_CONECTADO=1` en Vercel (Production) y redesplegar.
