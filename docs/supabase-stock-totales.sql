-- Conector MCP (api/mcp.js): existencias por producto y sucursal para consultar_inventario y para revisar
-- que las salidas/traspasos no pasen de lo que hay. ps_stock (base) + pos_stock_moves (kardex), igual que el
-- panel. Solo la llave de servicio puede llamarla. Aplicado en Supabase el 2026-10-22.
create or replace function public.stock_totales(p_ids bigint[])
returns table(id_product bigint, almacen text, cantidad numeric)
language sql stable security definer set search_path to 'public' as $$
  select t.id_product, t.almacen, sum(t.q) as cantidad from (
    select s.id_product,
           case s.id_warehouse when 53 then 'rumania' when 55 then 'puebla' when 56 then 'queretaro' end as almacen,
           s.quantity as q
      from ps_stock s where s.id_product = any(p_ids) and s.id_warehouse in (53, 55, 56)
    union all
    select m.id_product, m.almacen, m.qty
      from pos_stock_moves m where m.id_product = any(p_ids) and m.almacen in ('rumania', 'puebla', 'queretaro')
  ) t group by t.id_product, t.almacen
$$;
revoke execute on function public.stock_totales(bigint[]) from public, anon, authenticated;
grant execute on function public.stock_totales(bigint[]) to service_role;
