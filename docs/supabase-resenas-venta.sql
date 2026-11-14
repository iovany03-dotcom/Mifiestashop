-- Foto de la reseña del cliente ligada a cada venta (aplicado en Supabase el 2026-11-14, migración resenas_venta).
-- Lo usa api/resenas-venta.js con la llave de servicio; el navegador no tiene acceso directo.
create table if not exists public.resenas_venta (
  id bigint generated always as identity primary key,
  folio text not null unique,          -- folio del ticket (#POS-…, referencia del pedido…)
  sucursal text,
  path text not null,                  -- bucket privado resenas-venta
  media_type text not null,
  empleado_id bigint,
  subido_por text not null,
  creado_at timestamptz not null default now()
);
alter table public.resenas_venta enable row level security;
revoke all on table public.resenas_venta from anon, authenticated;
insert into storage.buckets (id, name, public) values ('resenas-venta', 'resenas-venta', false) on conflict (id) do nothing;
