-- Historial de movimientos (pestaña de Inventario), aplicado en Supabase el 2026-11-09
-- (migración historial_movimientos_incluye_recepciones_y_ajustes).
-- Además de entradas, salidas y traspasos, el historial trae las entradas de mercancía
-- (compra: recepciones), los ajustes directos antiguos (ajuste), los ajustes de entrada
-- aprobados (ajuste_entrada) y las cancelaciones de venta. Las ventas siguen solo en el Kardex.
CREATE OR REPLACE FUNCTION public.rpc_stock_move_list_manual(p_admin_password text, p_staff_email text, p_staff_pin text)
 RETURNS SETOF pos_stock_moves
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return query select * from public.pos_stock_moves
    where split_part(motivo, ':', 1) in ('entrada','salida','traspaso_salida','traspaso_entrada','compra','ajuste','ajuste_entrada','cancelacion')
       or revierte_id is not null
    order by created_at desc, id desc limit 1500;
end $function$;
