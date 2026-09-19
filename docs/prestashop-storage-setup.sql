-- One-time additive setup, BEFORE importing private customer addresses.
-- Execute as the database owner. No existing records or policies are altered.
begin;
create table if not exists public.ps_direcciones (
  id bigint primary key, id_customer bigint not null,
  alias text, firstname text, lastname text, company text,
  address1 text, address2 text, city text, postcode text,
  id_state bigint, id_country bigint, phone text, phone_mobile text,
  dni text, vat_number text, deleted boolean not null default false,
  active boolean not null default true, date_upd timestamp,
  synced_at timestamptz not null default now(), generation uuid not null
);
create index if not exists ps_direcciones_customer_idx on public.ps_direcciones(id_customer);
create table if not exists public.ps_productos_comercio (
  id bigint primary key, data jsonb not null, synced_at timestamptz not null default now(), generation uuid not null
);
create table if not exists public.ps_precios_especificos (
  id bigint primary key, data jsonb not null, synced_at timestamptz not null default now(), generation uuid not null
);
create table if not exists public.ps_disponibilidad (
  id bigint primary key, data jsonb not null, synced_at timestamptz not null default now(), generation uuid not null
);
create index if not exists ps_disponibilidad_product_idx on public.ps_disponibilidad((data->>'id_product'));
alter table public.ps_direcciones enable row level security;
alter table public.ps_productos_comercio enable row level security;
alter table public.ps_precios_especificos enable row level security;
alter table public.ps_disponibilidad enable row level security;
revoke all on public.ps_direcciones, public.ps_productos_comercio, public.ps_precios_especificos, public.ps_disponibilidad from public, anon, authenticated;
grant all on public.ps_direcciones, public.ps_productos_comercio, public.ps_precios_especificos, public.ps_disponibilidad to service_role;
commit;
