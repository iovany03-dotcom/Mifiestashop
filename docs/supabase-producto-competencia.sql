-- Datos extra por producto, SOLO para el panel de administración (nunca se muestran en la tienda):
--   * codigo_proveedor: el código con el que el proveedor identifica el producto.
--   * competencia: hasta 3 competidores, [{ "nombre": "Mercado Libre", "precio": 185.5, "enlace": "https://…" }].
--   * costo_compra_actualizado_at: la última vez que cambió el costo de compra (lo fija api/guardar-producto.js
--     al detectar que el costo cambió, y api/costo-compra.js al llenarlo en lote).
-- Van en una tabla aparte (y no en catalogo_productos) porque catalogo_productos se puede leer con la
-- llave pública (anon) para mostrar la tienda: cualquier columna que se agregue ahí quedaría a la vista de
-- cualquiera. producto_privado tiene RLS y ninguna política: solo la llave de servicio (API de Vercel, tras
-- validar la sesión del admin/personal) puede leerla o escribirla.
create table if not exists public.producto_privado (
  id bigint primary key,                              -- id del producto en catalogo_productos
  codigo_proveedor text,
  competencia jsonb not null default '[]'::jsonb,
  costo_compra_actualizado_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.producto_privado enable row level security;
revoke all on public.producto_privado from public, anon, authenticated;
grant select, insert, update, delete on public.producto_privado to service_role;

-- Opcional (limpieza): un intento anterior dejó esta función sin uso; no hace nada porque no tiene triggers.
-- drop function if exists public.catalogo_costo_actualizado();
