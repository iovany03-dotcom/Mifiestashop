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

## PrestaShop: desconectado por completo

Desde el 13 de octubre de 2026 el código ya no tiene ninguna conexión con
PrestaShop: no hay consultas en vivo, ni copia automática (cron), ni envío
de las ventas del POS. La tienda, el checkout, el POS, el admin, los
reportes y la API pública leen y escriben solo en Supabase. Las tablas
`ps_*` (pedidos, clientes, carritos, direcciones, categorías, stock,
movimientos, páginas, proveedores) se quedan como **histórico** y ya no se
actualizan desde PrestaShop.

Lo único que sigue en el DNS: **imágenes en `cdn1.mifiestashop.com` /
`cdn2.mifiestashop.com`**, que usan las páginas "Contáctanos" y "Política de
devolución". No tocar esos registros.

## Antes de cambiar el DNS

1. **Respaldo de la zona**: Cloudflare → DNS → Records → *Import and Export*
   → *Export*. Guardar ese archivo y dárselo a Claude: se guarda en la tabla
   privada `respaldo_dns` de Supabase (no en este repo, que es público — la
   zona revela la IP real de PrestaShop detrás de Cloudflare).

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
2. No hace falta quitar los dominios de Vercel ni tocar el código: la tienda
   nueva sigue disponible en `mifiestashop.vercel.app`.
