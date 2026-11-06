-- Existencias reales para la tienda en línea (aplicado en Supabase el 2026-11-06):
-- ps_stock (base congelada desde la migración) + pos_stock_moves (entradas, ventas, traspasos,
-- ajustes). Antes la página del producto, el feed de Google y los datos para Google leían solo
-- ps_stock, así que ninguna entrada hecha en el panel se veía en la tienda.
create or replace function public.stock_publico(p_ids bigint[])
returns table(id_product bigint, id_warehouse integer, cantidad numeric)
language sql stable security definer set search_path to 'public' as $$
  select t.id_product, t.wh, sum(t.q) from (
    select s.id_product, s.id_warehouse::int as wh, s.quantity::numeric as q
      from ps_stock s where s.id_product = any(p_ids)
    union all
    select m.id_product, case m.almacen when 'rumania' then 53 when 'puebla' then 55 when 'queretaro' then 56 end, m.qty
      from pos_stock_moves m where m.id_product = any(p_ids) and m.almacen in ('rumania','puebla','queretaro')
  ) t group by t.id_product, t.wh order by t.id_product, t.wh
$$;
revoke execute on function public.stock_publico(bigint[]) from public;
grant execute on function public.stock_publico(bigint[]) to anon, authenticated, service_role;

-- rpc_stock_move_totals (panel): mismo cuerpo de siempre + "order by m.id_product, m.almacen" para
-- que el panel la pueda pedir por páginas de 1,000 (ya pasa de 1,000 renglones; ver sbRpcTodo).
