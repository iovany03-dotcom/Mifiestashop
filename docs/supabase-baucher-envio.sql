-- Pedidos manuales (source = 'manual') para envío: el baucher de pago es obligatorio.
-- "Recolección en tienda" no es envío. Solo aplica al crear el pedido (la pantalla Crear Pedido ya lo
-- exige; esto evita que se salte desde otro lugar).
create or replace function public.pedidos_online_exige_baucher_envio() returns trigger
language plpgsql as $$
begin
  if new.source = 'manual'
     and coalesce(new.shipping_carrier, '') !~* '^(recolec|recoger)'
     and coalesce(btrim(new.comprobante_url), '') = '' then
    raise exception 'baucher_obligatorio_en_envios' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists pedidos_online_baucher_envio on public.pedidos_online;
create trigger pedidos_online_baucher_envio before insert on public.pedidos_online
  for each row execute function public.pedidos_online_exige_baucher_envio();
