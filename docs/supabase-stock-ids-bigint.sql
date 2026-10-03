-- Los productos creados desde la app tienen ids muy largos (ej. 10790803185325, > 2,147,483,647),
-- pero pos_stock_moves.id_product y las funciones del kardex/movimientos usaban INTEGER:
--   * mov_doc_save_core: (it->>'id_product')::int fallaba y salía "partida_invalida"
--     ("Hay productos con cantidad inválida") al guardar entradas/salidas/traspasos.
--   * mov_doc_approve_core, rpc_stock_move_insert_bulk (ventas POS/pedidos): mismo desbordamiento.
-- Se pasa todo a BIGINT (ps_stock y catalogo_productos ya lo eran). Ejecutar una vez.

begin;

alter table public.pos_stock_moves alter column id_product type bigint;

-- ---- Movimientos: guardar borrador ----
create or replace function public.mov_doc_save_core(p_id bigint, p_tipo text, p_origen text, p_destino text, p_motivo text, p_items jsonb, p_por text)
returns public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
declare
  v_items jsonb := '[]'::jsonb; it jsonb; v_id bigint; v_qty numeric;
  r public.mov_documentos; v_prefix text; v_folio text;
  v_ok text[] := array['rumania','puebla','queretaro'];
  v_origen text; v_destino text; v_motivo text;
begin
  if p_tipo is null or p_tipo not in ('entrada','salida','traspaso') then raise exception 'tipo_invalido'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'sin_productos'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'demasiadas_partidas'; end if;
  if p_tipo in ('salida','traspaso') and (p_origen is null or not (p_origen = any(v_ok))) then raise exception 'bodega_invalida'; end if;
  if p_tipo in ('entrada','traspaso') and (p_destino is null or not (p_destino = any(v_ok))) then raise exception 'bodega_invalida'; end if;
  if p_tipo = 'traspaso' and p_origen = p_destino then raise exception 'bodega_invalida'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    begin
      v_id := (it->>'id_product')::bigint; v_qty := (it->>'qty')::numeric;
    exception when others then
      raise exception 'partida_invalida';
    end;
    if v_id is null or v_id <= 0 or v_qty is null or v_qty <= 0 or v_qty <> trunc(v_qty) or v_qty > 99999 then raise exception 'partida_invalida'; end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id_product', v_id, 'qty', v_qty::int,
      'name', left(coalesce(it->>'name',''), 200), 'sku', left(coalesce(it->>'sku',''), 200)));
  end loop;
  v_origen := case when p_tipo = 'entrada' then null else p_origen end;
  v_destino := case when p_tipo = 'salida' then null else p_destino end;
  v_motivo := nullif(left(trim(coalesce(p_motivo,'')), 300), '');
  v_prefix := case p_tipo when 'entrada' then 'ENT' when 'salida' then 'SAL' else 'TR' end;

  if p_id is null then
    v_folio := v_prefix || '-' || to_char(now() at time zone 'America/Mexico_City','YYMMDD') || '-' || lpad(nextval('public.mov_doc_seq')::text, 4, '0');
    insert into public.mov_documentos (folio, tipo, origen, destino, motivo, items, creado_por, actualizado_por)
    values (v_folio, p_tipo, v_origen, v_destino, v_motivo, v_items, left(p_por,100), left(p_por,100))
    returning * into r;
  else
    select * into r from public.mov_documentos where id = p_id for update;
    if not found then raise exception 'no_encontrado'; end if;
    if r.estado <> 'borrador' then raise exception 'no_borrador'; end if;
    v_folio := r.folio;
    if split_part(v_folio,'-',1) <> v_prefix then v_folio := v_prefix || substr(v_folio, position('-' in v_folio)); end if;
    update public.mov_documentos
       set folio = v_folio, tipo = p_tipo, origen = v_origen, destino = v_destino, motivo = v_motivo,
           items = v_items, actualizado_por = left(p_por,100), actualizado_at = now()
     where id = p_id returning * into r;
  end if;
  return r;
end $$;

-- ---- Movimientos: aprobar (aplica al kardex) ----
create or replace function public.mov_doc_approve_core(p_id bigint, p_por text)
returns public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
declare r public.mov_documentos; it jsonb; v_nota text; v_reg text;
begin
  if p_por is null or btrim(p_por) = '' then raise exception 'sin_aprobador'; end if;
  select * into r from public.mov_documentos where id = p_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado <> 'borrador' then raise exception 'no_borrador'; end if;
  v_nota := nullif(trim(coalesce(r.motivo,'')), '');
  v_reg := left(coalesce(r.creado_por,'Sistema'), 100);
  for it in select * from jsonb_array_elements(r.items) loop
    if r.tipo = 'entrada' then
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.destino, (it->>'qty')::numeric, case when v_nota is null then 'entrada' else 'entrada: ' || v_nota end, r.folio, v_reg);
    elsif r.tipo = 'salida' then
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.origen, -(it->>'qty')::numeric, case when v_nota is null then 'salida' else 'salida: ' || v_nota end, r.folio, v_reg);
    else
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.origen, -(it->>'qty')::numeric, case when v_nota is null then 'traspaso_salida' else 'traspaso_salida: ' || v_nota end, r.folio, v_reg);
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.destino, (it->>'qty')::numeric, case when v_nota is null then 'traspaso_entrada' else 'traspaso_entrada: ' || v_nota end, r.folio, v_reg);
    end if;
  end loop;
  update public.mov_documentos set estado = 'aprobado', aprobado_por = left(p_por,100), aprobado_at = now()
   where id = p_id returning * into r;
  return r;
end $$;

-- ---- Ventas POS / pedidos manuales: movimientos en lote ----
create or replace function public.rpc_stock_move_insert_bulk(p_admin_password text, p_staff_email text, p_staff_pin text, p_moves jsonb)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare m jsonb; n integer := 0;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  for m in select * from jsonb_array_elements(p_moves) loop
    insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
    values (
      (m->>'id_product')::bigint,
      m->>'almacen',
      (m->>'qty')::numeric,
      coalesce(m->>'motivo', 'ajuste'),
      m->>'folio',
      m->>'registrado_por'
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---- Totales por producto/almacén (cambia el tipo de la columna devuelta) ----
drop function if exists public.rpc_stock_move_totals(text, text, text);
create function public.rpc_stock_move_totals(p_admin_password text, p_staff_email text, p_staff_pin text)
returns table(id_product bigint, almacen text, delta numeric)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return query
    select m.id_product, m.almacen, sum(m.qty) as delta
    from pos_stock_moves m
    group by m.id_product, m.almacen;
end;
$$;
grant execute on function public.rpc_stock_move_totals(text, text, text) to public, anon, authenticated, service_role;

-- ---- Kardex ----
drop function if exists public.rpc_kardex(text, text, text, integer, integer, date, date, integer);
create function public.rpc_kardex(p_admin_password text, p_staff_email text, p_staff_pin text, p_id_product bigint default null, p_id_warehouse integer default null, p_desde date default null, p_hasta date default null, p_limit integer default 500)
returns table(fecha text, id_product bigint, producto text, id_warehouse integer, almacen text, tipo text, cantidad numeric, empleado text, referencia text, origen text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return query
  with ps as (
    select to_char((m.data->>'date_add')::timestamp, 'YYYY-MM-DD HH24:MI:SS') as fecha,
           (m.data->>'id_product')::bigint as id_product,
           coalesce(nullif(m.data->'product_name'->0->>'value', ''), m.data->>'reference') as producto,
           (m.data->>'id_warehouse')::int as id_warehouse,
           case m.data->>'id_stock_mvt_reason'
             when '1' then 'Entrada' when '2' then 'Salida' when '3' then 'Venta'
             when '4' then 'Ajuste de inventario' when '5' then 'Ajuste de inventario'
             when '6' then 'Traspaso (sale)' when '7' then 'Traspaso (entra)' when '8' then 'Orden de compra'
             else 'Movimiento ' || coalesce(m.data->>'id_stock_mvt_reason', '') end as tipo,
           (m.data->>'sign')::numeric * (m.data->>'physical_quantity')::numeric as cantidad,
           e.name as empleado,
           case when coalesce(m.data->>'id_order', '0') <> '0' then 'Pedido ' || (m.data->>'id_order')
                when coalesce(m.data->>'id_supply_order', '0') <> '0' then 'Orden de compra ' || (m.data->>'id_supply_order')
                else null end as referencia,
           'PrestaShop'::text as origen
    from ps_inventory_movements m
    left join ps_empleados e on e.id = nullif(m.data->>'id_employee', '')::bigint
    where (p_id_product is null or (m.data->>'id_product')::bigint = p_id_product)
      and (m.data->>'id_warehouse')::int between 53 and 58
      and (p_id_warehouse is null or (m.data->>'id_warehouse')::int = p_id_warehouse)
      and (p_desde is null or m.data->>'date_add' >= to_char(p_desde, 'YYYY-MM-DD'))
      and (p_hasta is null or m.data->>'date_add' < to_char(p_hasta + 1, 'YYYY-MM-DD'))
  ), app as (
    select to_char(s.created_at at time zone 'America/Mexico_City', 'YYYY-MM-DD HH24:MI:SS') as fecha,
           s.id_product,
           c.name as producto,
           case s.almacen when 'rumania' then 53 when 'puebla' then 55 when 'queretaro' then 56 end as id_warehouse,
           case s.motivo
             when 'venta_pos' then 'Venta POS' when 'pedido_manual' then 'Pedido manual'
             when 'cancelacion' then 'Cancelación (regreso)'
             else initcap(replace(coalesce(s.motivo, 'movimiento'), '_', ' ')) end as tipo,
           s.qty as cantidad,
           s.registrado_por as empleado,
           s.folio as referencia,
           'Mi Fiestashop'::text as origen
    from pos_stock_moves s
    left join catalogo_productos c on c.id = s.id_product
    where (p_id_product is null or s.id_product = p_id_product)
      and (p_desde is null or s.created_at >= (p_desde::timestamp at time zone 'America/Mexico_City'))
      and (p_hasta is null or s.created_at < ((p_hasta + 1)::timestamp at time zone 'America/Mexico_City'))
  )
  select x.fecha, x.id_product, x.producto, x.id_warehouse, a.name as almacen, x.tipo, x.cantidad, x.empleado, x.referencia, x.origen
  from (select * from ps union all select * from app) x
  left join ps_almacenes a on a.id = x.id_warehouse
  where p_id_warehouse is null or x.id_warehouse = p_id_warehouse
  order by x.fecha desc
  limit least(greatest(coalesce(p_limit, 500), 1), 5000);
end;
$$;
revoke execute on function public.rpc_kardex(text, text, text, bigint, integer, date, date, integer) from public;
grant execute on function public.rpc_kardex(text, text, text, bigint, integer, date, date, integer) to anon, authenticated, service_role;

commit;
