-- Resumen de una caja abierta (ventas por método de pago y salidas desde su apertura), calculado en la base.
-- rpc_pos_ticket_list solo devuelve los últimos 200 tickets de todas las sucursales, así que una caja abierta
-- varios días perdía ventas. No cuenta tickets cancelados. Ya aplicada en Supabase (migración rpc_caja_resumen).
create or replace function public.rpc_caja_resumen(p_admin_password text, p_staff_email text, p_staff_pin text, p_almacen text, p_desde timestamptz)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r jsonb;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  select jsonb_build_object(
    'efectivo',      coalesce(sum(total) filter (where metodo = 'cash'), 0),
    'tarjeta',       coalesce(sum(total) filter (where metodo = 'card'), 0),
    'transferencia', coalesce(sum(total) filter (where metodo = 'transfer'), 0),
    'tickets_efectivo',      count(*) filter (where metodo = 'cash'),
    'tickets_tarjeta',       count(*) filter (where metodo = 'card'),
    'tickets_transferencia', count(*) filter (where metodo = 'transfer'),
    'salidas', (select coalesce(sum(monto), 0) from salidas_caja where almacen = p_almacen and created_at >= p_desde),
    'num_salidas', (select count(*) from salidas_caja where almacen = p_almacen and created_at >= p_desde)
  ) into r
  from pos_tickets
  where almacen = p_almacen and created_at >= p_desde and coalesce(estado, '') <> 'Cancelado';
  return r;
end $$;
grant execute on function public.rpc_caja_resumen(text, text, text, text, timestamptz) to anon, authenticated;
