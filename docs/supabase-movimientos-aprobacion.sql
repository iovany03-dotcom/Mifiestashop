-- Movimientos de inventario con borrador y aprobación (aplicado en Supabase el 2026-10-02,
-- migración "mov_documentos_borrador_aprobacion"). Este archivo es la referencia para
-- recrearlo; el cliente está en index.html (sección "Documentos de movimiento").
--
-- Flujo: rpc_mov_doc_save guarda un borrador (no toca el inventario) -> rpc_mov_doc_approve
-- lo aplica a pos_stock_moves y registra quién aprobó y cuándo. Los nombres de quien
-- captura y de quien aprueba salen de la sesión en el servidor (mov_actor), no del navegador.
-- Aprobar exige la contraseña de administrador o el permiso 'aprobar-movimientos'
-- en personal_equipo.permisos (mov_can_approve).

create sequence if not exists public.mov_doc_seq;

create table if not exists public.mov_documentos (
  id bigint generated always as identity primary key,
  folio text not null unique,
  tipo text not null check (tipo in ('entrada','salida','traspaso')),
  origen text,
  destino text,
  motivo text,
  items jsonb not null,
  estado text not null default 'borrador' check (estado in ('borrador','aprobado')),
  creado_por text,
  creado_at timestamptz not null default now(),
  actualizado_por text,
  actualizado_at timestamptz not null default now(),
  aprobado_por text,
  aprobado_at timestamptz,
  constraint mov_documentos_aprobacion_completa check ((estado = 'aprobado') = (aprobado_por is not null and aprobado_at is not null))
);
alter table public.mov_documentos enable row level security;
revoke all on table public.mov_documentos from anon, authenticated;
revoke all on sequence public.mov_doc_seq from anon, authenticated;

-- Internas (sin permiso para anon): identidad, permiso y lógica de guardar/aprobar.
create or replace function public.mov_actor(p_admin_password text, p_staff_email text, p_staff_pin text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v text;
begin
  if p_admin_password is not null and rpc_check_admin(p_admin_password) then return 'Administrador'; end if;
  if p_staff_email is not null and p_staff_pin is not null then
    select nombre into v from personal_equipo
      where lower(email) = lower(p_staff_email) and pin = p_staff_pin and estado = 'Activo' limit 1;
    return v;
  end if;
  return null;
end $$;

create or replace function public.mov_can_approve(p_admin_password text, p_staff_email text, p_staff_pin text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  if p_admin_password is not null and rpc_check_admin(p_admin_password) then return true; end if;
  if p_staff_email is not null and p_staff_pin is not null then
    return exists(select 1 from personal_equipo
      where lower(email) = lower(p_staff_email) and pin = p_staff_pin and estado = 'Activo'
        and permisos ? 'aprobar-movimientos');
  end if;
  return false;
end $$;

create or replace function public.mov_doc_save_core(p_id bigint, p_tipo text, p_origen text, p_destino text, p_motivo text, p_items jsonb, p_por text)
returns public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
declare
  v_items jsonb := '[]'::jsonb; it jsonb; v_id int; v_qty numeric;
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
      v_id := (it->>'id_product')::int; v_qty := (it->>'qty')::numeric;
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
      values ((it->>'id_product')::int, r.destino, (it->>'qty')::numeric, case when v_nota is null then 'entrada' else 'entrada: ' || v_nota end, r.folio, v_reg);
    elsif r.tipo = 'salida' then
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::int, r.origen, -(it->>'qty')::numeric, case when v_nota is null then 'salida' else 'salida: ' || v_nota end, r.folio, v_reg);
    else
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::int, r.origen, -(it->>'qty')::numeric, case when v_nota is null then 'traspaso_salida' else 'traspaso_salida: ' || v_nota end, r.folio, v_reg);
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por)
      values ((it->>'id_product')::int, r.destino, (it->>'qty')::numeric, case when v_nota is null then 'traspaso_entrada' else 'traspaso_entrada: ' || v_nota end, r.folio, v_reg);
    end if;
  end loop;
  update public.mov_documentos set estado = 'aprobado', aprobado_por = left(p_por,100), aprobado_at = now()
   where id = p_id returning * into r;
  return r;
end $$;

revoke execute on function public.mov_actor(text,text,text) from public, anon, authenticated;
revoke execute on function public.mov_can_approve(text,text,text) from public, anon, authenticated;
revoke execute on function public.mov_doc_save_core(bigint,text,text,text,text,jsonb,text) from public, anon, authenticated;
revoke execute on function public.mov_doc_approve_core(bigint,text) from public, anon, authenticated;

-- Públicas (las llama index.html con la llave anónima; cada una valida la sesión).
create or replace function public.rpc_mov_doc_save(p_admin_password text, p_staff_email text, p_staff_pin text, p_id bigint, p_tipo text, p_origen text, p_destino text, p_motivo text, p_items jsonb)
returns public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
declare v_actor text;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  v_actor := coalesce(mov_actor(p_admin_password, p_staff_email, p_staff_pin), 'Administrador');
  return mov_doc_save_core(p_id, p_tipo, p_origen, p_destino, p_motivo, p_items, v_actor);
end $$;

create or replace function public.rpc_mov_doc_list(p_admin_password text, p_staff_email text, p_staff_pin text)
returns setof public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return query select * from public.mov_documentos order by id desc limit 300;
end $$;

create or replace function public.rpc_mov_doc_approve(p_admin_password text, p_staff_email text, p_staff_pin text, p_id bigint)
returns public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
declare v_actor text;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  if not mov_can_approve(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'sin_permiso_aprobar'; end if;
  v_actor := mov_actor(p_admin_password, p_staff_email, p_staff_pin);
  return mov_doc_approve_core(p_id, v_actor);
end $$;

create or replace function public.rpc_mov_doc_delete(p_admin_password text, p_staff_email text, p_staff_pin text, p_id bigint)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v bigint;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  delete from public.mov_documentos where id = p_id and estado = 'borrador' returning id into v;
  if v is null then raise exception 'no_borrador'; end if;
  return true;
end $$;

create or replace function public.rpc_mov_can_approve(p_admin_password text, p_staff_email text, p_staff_pin text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return mov_can_approve(p_admin_password, p_staff_email, p_staff_pin);
end $$;

-- Renglones manuales de pos_stock_moves (sin ventas, pedidos manuales ni cancelaciones):
-- los usa el Historial para los movimientos anteriores a este sistema y para detectar reversas.
create or replace function public.rpc_stock_move_list_manual(p_admin_password text, p_staff_email text, p_staff_pin text)
returns setof public.pos_stock_moves language plpgsql security definer set search_path to 'public' as $$
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  return query select * from public.pos_stock_moves
    where split_part(motivo, ':', 1) in ('entrada','salida','traspaso_salida','traspaso_entrada') or revierte_id is not null
    order by created_at desc, id desc limit 800;
end $$;
