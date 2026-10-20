-- Historial de movimientos de los pedidos (quién, qué, día y hora).
-- Privada: solo escribe/lee el servidor con la llave service_role (api/pedido-admin.js, api/facturama.js, lib/mp-pago.js).
create table if not exists public.pedido_historial (
  id bigint generated always as identity primary key,
  folio text not null,
  origen text not null,
  accion text not null,
  detalle text,
  usuario text,
  created_at timestamptz not null default now()
);
create index if not exists pedido_historial_folio_idx on public.pedido_historial (folio, created_at desc);
alter table public.pedido_historial enable row level security;
revoke all on public.pedido_historial from anon, authenticated;

-- Nombre de quien hace la acción, sacado de la sesión (nunca de lo que mande el navegador).
-- Devuelve null si la sesión no es válida.
create or replace function public.rpc_actor_name(p_admin_password text, p_staff_email text, p_staff_pin text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then return null; end if;
  return coalesce(public.mov_actor(p_admin_password, p_staff_email, p_staff_pin), 'Administrador');
end $$;
