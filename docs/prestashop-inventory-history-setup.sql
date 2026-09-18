begin;
-- Historical source documents are never inserted into pos_stock_moves:
-- their effects are already included in the imported stock snapshot.
create table if not exists public.ps_inventory_documents (
 id bigint primary key,
 data jsonb not null,
 imported_at timestamptz not null default now()
);
create table if not exists public.ps_inventory_movements (
 id bigint primary key,
 data jsonb not null,
 imported_at timestamptz not null default now()
);
alter table public.ps_inventory_documents enable row level security;
alter table public.ps_inventory_movements enable row level security;
revoke all on public.ps_inventory_documents,public.ps_inventory_movements from public,anon,authenticated;
grant all on public.ps_inventory_documents,public.ps_inventory_movements to service_role;
commit;
