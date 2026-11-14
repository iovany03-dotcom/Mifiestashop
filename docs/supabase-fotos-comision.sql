-- Fotos de tienda para la comisión quincenal (aplicado en Supabase el 2026-11-14, migración fotos_comision).
-- Lo usa api/fotos-comision.js (llave de servicio); el navegador no tiene acceso directo.
create table if not exists public.fotos_comision (
  id bigint generated always as identity primary key,
  periodo date not null,              -- fecha de la quincena que se paga (ej. 2026-11-15)
  empleado_id bigint not null,
  empleado text not null,
  sucursal text not null check (sucursal in ('rumania','puebla','queretaro')),
  archivos jsonb not null default '[]'::jsonb,   -- [{path, media_type, at}]
  estado text not null default 'enviado' check (estado in ('enviado','aprobado','rechazado')),
  nota text,
  revisado_por text,
  revisado_at timestamptz,
  creado_at timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  unique (periodo, empleado_id, sucursal)
);
alter table public.fotos_comision enable row level security;
revoke all on table public.fotos_comision from anon, authenticated;
insert into storage.buckets (id, name, public) values ('fotos-comision', 'fotos-comision', false) on conflict (id) do nothing;
