-- Ajuste general de inventario (aplicado en Supabase el 2026-11-09, migración mov_ajuste_general).
-- Nuevo tipo de movimiento "ajuste": por cada producto se captura la CANTIDAD NUEVA en una bodega
-- (`contado`) y, al aprobar, se aplica la diferencia contra la existencia de ese momento: si sube
-- entra con motivo "ajuste_entrada: …" y si baja sale con "ajuste_salida: …". Si en ningún producto
-- hay diferencia, no se aprueba (ajuste_sin_diferencia). Folio AJU-AAMMDD-NNNN; se puede revertir.
-- No es entrada ni salida: es un ajuste directo a la cantidad, con motivo obligatorio y aprobación.

alter table public.mov_documentos drop constraint mov_documentos_tipo_check;
alter table public.mov_documentos add constraint mov_documentos_tipo_check
  check (tipo = any (array['entrada'::text, 'salida'::text, 'traspaso'::text, 'ajuste'::text]));

CREATE OR REPLACE FUNCTION public.mov_doc_save_core(p_id bigint, p_tipo text, p_origen text, p_destino text, p_motivo text, p_items jsonb, p_por text)
 RETURNS mov_documentos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_items jsonb := '[]'::jsonb; it jsonb; v_id bigint; v_qty numeric;
  r public.mov_documentos; v_prefix text; v_folio text;
  v_ok text[] := array['rumania','puebla','queretaro'];
  v_origen text; v_destino text; v_motivo text; v_contado int; v_sistema int;
begin
  if p_tipo is null or p_tipo not in ('entrada','salida','traspaso','ajuste') then raise exception 'tipo_invalido'; end if;
  v_motivo := nullif(left(trim(coalesce(p_motivo,'')), 300), '');
  if p_tipo = 'entrada' and (v_motivo is null or v_motivo !~* '^(devolucion|correccion|conteo):\s*\S.{4,}') then
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.';
  end if;
  if p_tipo = 'ajuste' and (v_motivo is null or length(regexp_replace(v_motivo, '\s', '', 'g')) < 5) then raise exception 'ajuste_sin_motivo'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'sin_productos'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'demasiadas_partidas'; end if;
  if p_tipo in ('salida','traspaso') and (p_origen is null or not (p_origen = any(v_ok))) then raise exception 'bodega_invalida'; end if;
  if p_tipo in ('entrada','traspaso','ajuste') and (p_destino is null or not (p_destino = any(v_ok))) then raise exception 'bodega_invalida'; end if;
  if p_tipo = 'traspaso' and p_origen = p_destino then raise exception 'bodega_invalida'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    begin
      v_id := (it->>'id_product')::bigint;
    exception when others then
      raise exception 'partida_invalida';
    end;
    v_contado := case when coalesce(it->>'contado','') ~ '^\d{1,6}$' then (it->>'contado')::int end;
    v_sistema := case when coalesce(it->>'sistema','') ~ '^-?\d{1,6}$' then (it->>'sistema')::int end;
    if p_tipo = 'ajuste' then
      -- Ajuste: lo que cuenta es la cantidad nueva; qty es solo la diferencia esperada (se recalcula al aprobar).
      if v_id is null or v_id <= 0 or v_contado is null then raise exception 'partida_invalida'; end if;
      v_qty := v_contado - coalesce(v_sistema, 0);
    else
      begin
        v_qty := (it->>'qty')::numeric;
      exception when others then
        raise exception 'partida_invalida';
      end;
      if v_id is null or v_id <= 0 or v_qty is null or v_qty <= 0 or v_qty <> trunc(v_qty) or v_qty > 99999 then raise exception 'partida_invalida'; end if;
    end if;
    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id_product', v_id, 'qty', v_qty::int,
      'name', left(coalesce(it->>'name',''), 200), 'sku', left(coalesce(it->>'sku',''), 200),
      'contado', case when p_tipo = 'ajuste' or (p_tipo = 'entrada' and v_motivo ~* '^conteo:') then v_contado end,
      'sistema', case when p_tipo = 'ajuste' or (p_tipo = 'entrada' and v_motivo ~* '^conteo:') then v_sistema end)));
  end loop;
  v_origen := case when p_tipo in ('entrada','ajuste') then null else p_origen end;
  v_destino := case when p_tipo = 'salida' then null else p_destino end;
  v_prefix := case p_tipo when 'entrada' then 'AJE' when 'salida' then 'SAL' when 'ajuste' then 'AJU' else 'TR' end;

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
end $function$;

CREATE OR REPLACE FUNCTION public.mov_doc_approve_core(p_id bigint, p_por text)
 RETURNS mov_documentos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.mov_documentos; it jsonb; v_nota text; v_reg text; v_qty numeric; v_actual numeric;
  v_items jsonb := '[]'::jsonb; v_conteo boolean; v_sin text[] := '{}'; v_cambios int := 0;
begin
  if p_por is null or btrim(p_por) = '' then raise exception 'sin_aprobador'; end if;
  select * into r from public.mov_documentos where id = p_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado <> 'borrador' then raise exception 'no_borrador'; end if;
  if r.tipo = 'entrada' and coalesce(r.motivo, '') !~* '^(devolucion|correccion|conteo):\s*\S.{4,}' then
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.';
  end if;
  v_nota := nullif(trim(coalesce(r.motivo,'')), '');
  v_reg := left(coalesce(r.creado_por,'Sistema'), 100);

  -- Ajuste general: a cada producto se le deja la cantidad nueva; se aplica la diferencia contra AHORA.
  if r.tipo = 'ajuste' then
    for it in select * from jsonb_array_elements(r.items) loop
      select coalesce(sum(cantidad), 0) into v_actual from stock_totales(array[(it->>'id_product')::bigint]) where almacen = r.destino;
      v_qty := (it->>'contado')::numeric - v_actual;
      if v_qty > 0 then
        perform set_config('mfs.ingreso', 'ajuste', true);
        insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
        values ((it->>'id_product')::bigint, r.destino, v_qty, 'ajuste_entrada: ' || coalesce(v_nota, ''), r.folio, v_reg);
        perform set_config('mfs.ingreso', '', true);
        v_cambios := v_cambios + 1;
      elsif v_qty < 0 then
        insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
        values ((it->>'id_product')::bigint, r.destino, v_qty, 'ajuste_salida: ' || coalesce(v_nota, ''), r.folio, v_reg);
        v_cambios := v_cambios + 1;
      end if;
      v_items := v_items || jsonb_build_array(it || jsonb_build_object('qty', v_qty::int, 'sistema', v_actual::int));
    end loop;
    if v_cambios = 0 then raise exception 'ajuste_sin_diferencia'; end if;
    update public.mov_documentos set estado = 'aprobado', aprobado_por = left(p_por,100), aprobado_at = now(), items = v_items
     where id = p_id returning * into r;
    return r;
  end if;

  v_conteo := r.tipo = 'entrada' and coalesce(r.motivo,'') ~* '^conteo:';
  -- Conteo físico: la cantidad a sumar es lo contado menos lo que hay AHORA en el sistema.
  if v_conteo then
    for it in select * from jsonb_array_elements(r.items) loop
      if it ? 'contado' then
        select coalesce(sum(cantidad), 0) into v_actual from stock_totales(array[(it->>'id_product')::bigint]) where almacen = r.destino;
        v_qty := (it->>'contado')::numeric - v_actual;
        if v_qty <= 0 then v_sin := v_sin || (coalesce(nullif(it->>'name',''), it->>'id_product') || ' (contado ' || (it->>'contado') || ', sistema ' || v_actual::int || ')'); end if;
        v_items := v_items || jsonb_build_array(it || jsonb_build_object('qty', v_qty::int, 'sistema', v_actual::int));
      else
        v_items := v_items || jsonb_build_array(it);
      end if;
    end loop;
    if array_length(v_sin, 1) > 0 then raise exception 'conteo_sin_diferencia: %', array_to_string(v_sin, '; '); end if;
    r.items := v_items;
  end if;
  for it in select * from jsonb_array_elements(r.items) loop
    if r.tipo = 'entrada' then
      perform set_config('mfs.ingreso', 'ajuste', true);
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.destino, (it->>'qty')::numeric, 'ajuste_entrada: ' || coalesce(v_nota, ''), r.folio, v_reg);
    elsif r.tipo = 'salida' then
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.origen, -(it->>'qty')::numeric, case when v_nota is null then 'salida' else 'salida: ' || v_nota end, r.folio, v_reg);
    else
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.origen, -(it->>'qty')::numeric, case when v_nota is null then 'traspaso_salida' else 'traspaso_salida: ' || v_nota end, r.folio, v_reg);
      perform set_config('mfs.ingreso', 'traspaso', true);
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::bigint, r.destino, (it->>'qty')::numeric, case when v_nota is null then 'traspaso_entrada' else 'traspaso_entrada: ' || v_nota end, r.folio, v_reg);
    end if;
    perform set_config('mfs.ingreso', '', true);
  end loop;
  update public.mov_documentos set estado = 'aprobado', aprobado_por = left(p_por,100), aprobado_at = now(), items = r.items
   where id = p_id returning * into r;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.rpc_stock_move_revert(p_admin_password text, p_staff_email text, p_staff_pin text, p_folio text, p_registrado_por text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  if p_folio is null or p_folio !~ '^(ENT|SAL|TR|AJE|AJU)-[A-Za-z0-9-]{1,40}$' then raise exception 'no_revertible'; end if;
  if exists (select 1 from pos_stock_moves where folio = p_folio
             and split_part(motivo, ':', 1) not in ('entrada', 'salida', 'traspaso_salida', 'traspaso_entrada', 'ajuste_entrada', 'ajuste_salida')) then
    raise exception 'no_revertible';
  end if;
  perform set_config('mfs.ingreso', 'reversion', true);
  begin
    insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por, revierte_id)
    select id_product, almacen, -qty, 'ajuste: Reversa de #' || folio, 'REV-' || folio, left(p_registrado_por, 100), id
    from pos_stock_moves
    where folio = p_folio;
    get diagnostics n = row_count;
  exception when unique_violation then
    raise exception 'ya_revertido';
  end;
  perform set_config('mfs.ingreso', '', true);
  if n = 0 then raise exception 'no_revertible'; end if;
  return n;
end $function$;

-- El historial también trae los renglones de ajuste_salida.
CREATE OR REPLACE FUNCTION public.rpc_stock_move_list_manual(p_admin_password text, p_staff_email text, p_staff_pin text)
 RETURNS SETOF pos_stock_moves
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return query select * from public.pos_stock_moves
    where split_part(motivo, ':', 1) in ('entrada','salida','traspaso_salida','traspaso_entrada','compra','ajuste','ajuste_entrada','ajuste_salida','cancelacion')
       or revierte_id is not null
    order by created_at desc, id desc limit 1500;
end $function$;
