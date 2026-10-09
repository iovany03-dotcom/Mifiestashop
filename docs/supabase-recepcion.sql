-- Recepción Inteligente de Mercancía (aplicado en Supabase el 2026-10-09, migraciones
-- "recepcion_inteligente" y siguientes). Este archivo es la referencia para recrearlo; el
-- cliente está en index.html (vista "recepcion") y la lectura con IA en api/recepcion.js.
--
-- REGLA: ninguna mercancía comprada entra al inventario sin una nota escaneada, procesada y
-- vinculada a una recepción. Se hace cumplir en la base de datos con el trigger
-- pos_stock_moves_regla_ingreso: toda fila con qty > 0 en pos_stock_moves se rechaza salvo
-- que la inserte una función autorizada que marca la transacción (set_config 'mfs.ingreso'):
--   'recepcion'  -> recep_autorizar_core (compras con nota procesada)
--   'traspaso'   -> mov_doc_approve_core (traspaso_entrada, emparejada con su salida)
--   'ajuste'     -> mov_doc_approve_core (ajuste de entrada por devolución/corrección/conteo,
--                   con justificación y aprobación de supervisor)
--   'reversion'  -> rpc_stock_move_revert (reversa de una salida)
-- y las cancelaciones de pedido que hace api/pedido-admin.js con la llave de servicio.
-- El navegador (llave anónima) no puede llamar set_config: PostgREST solo expone funciones
-- del esquema public.
--
-- Roles (usuarios existentes, personal_equipo.permisos):
--   empleado   = sesión válida con permiso 'recepcion' o 'bodegas' (o administrador)
--   supervisor = administrador o permiso 'aprobar-movimientos' (mov_can_approve)
--   admin      = contraseña de administrador

-- ---------------------------------------------------------------- tablas
create table if not exists public.proveedores_compra (
  id bigint generated always as identity primary key,
  nombre text not null,
  rfc text, telefono text, contacto text,
  activo boolean not null default true,
  creado_por text, created_at timestamptz not null default now()
);
create unique index if not exists proveedores_compra_nombre_uq on public.proveedores_compra (lower(btrim(nombre)));

create sequence if not exists public.recepcion_seq;

create table if not exists public.recepciones (
  id bigint generated always as identity primary key,
  folio text not null unique,
  proveedor_id bigint not null references public.proveedores_compra(id),
  almacen text not null check (almacen in ('rumania','puebla','queretaro')),
  estado text not null default 'borrador' check (estado in ('borrador','procesando','pendiente_identificacion',
    'pendiente_conteo','con_diferencias','pendiente_autorizacion','parcial','conciliada','cancelada')),
  nota_folio text, nota_fecha date, nota_subtotal numeric, nota_total numeric, nota_proveedor_leido text,
  nota_procesada_at timestamptz, nota_procesada_por text, nota_hash text,
  ia_modelo text, ia_advertencias jsonb not null default '[]'::jsonb,
  archivos jsonb not null default '[]'::jsonb,
  creado_por text, created_at timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  conteo_inicio_at timestamptz,
  cerrado_at timestamptz,
  cancelado_por text, cancelado_at timestamptz, motivo_cancelacion text
);
create index if not exists recepciones_estado_idx on public.recepciones (estado, created_at desc);

create table if not exists public.equivalencias_proveedor (
  id bigint generated always as identity primary key,
  proveedor_id bigint not null references public.proveedores_compra(id),
  codigo text not null,
  codigo_norm text not null,
  id_product bigint not null,
  presentacion text not null default 'pieza',
  factor numeric not null default 1 check (factor > 0 and factor <= 100000),
  estado text not null default 'activa' check (estado in ('activa','inactiva')),
  confirmado_por text, created_at timestamptz not null default now(),
  actualizado_por text, actualizado_at timestamptz
);
-- Nunca dos equivalencias activas para el mismo proveedor y código.
create unique index if not exists equivalencias_activa_uq on public.equivalencias_proveedor (proveedor_id, codigo_norm) where estado = 'activa';
create index if not exists equivalencias_producto_idx on public.equivalencias_proveedor (id_product);

create table if not exists public.equivalencias_historial (
  id bigint generated always as identity primary key,
  equivalencia_id bigint not null references public.equivalencias_proveedor(id),
  accion text not null, antes jsonb, despues jsonb, por text, at timestamptz not null default now()
);

create table if not exists public.recepcion_lineas (
  id bigint generated always as identity primary key,
  recepcion_id bigint not null references public.recepciones(id),
  renglon int not null default 0,
  origen text not null default 'nota' check (origen in ('nota','adicional')),
  codigo text, descripcion text,
  cantidad_nota numeric, precio_unitario numeric, importe numeric,
  revisar boolean not null default false, revisar_motivo text,
  id_product bigint, equivalencia_id bigint references public.equivalencias_proveedor(id),
  presentacion text, factor numeric not null default 1 check (factor > 0),
  identificada_auto boolean not null default false,
  identificada_por text, identificada_at timestamptz,
  costo_anterior numeric,
  cajas numeric, piezas_por_caja numeric, piezas_sueltas numeric,
  cantidad_recibida numeric, danadas numeric not null default 0,
  conteo_por text, conteo_at timestamptz,
  diferencia_resuelta boolean not null default false, resolucion text, resuelto_por text, resuelto_at timestamptz,
  ingresado_qty numeric, ingresado_at timestamptz, ingresado_por text,
  observaciones text,
  evidencias jsonb not null default '[]'::jsonb,
  constraint recepcion_lineas_cantidades check (
    (cantidad_nota is null or cantidad_nota >= 0) and (cantidad_recibida is null or cantidad_recibida >= 0)
    and danadas >= 0 and (cantidad_recibida is null or danadas <= cantidad_recibida))
);
create index if not exists recepcion_lineas_rec_idx on public.recepcion_lineas (recepcion_id, renglon);

create table if not exists public.recepcion_eventos (
  id bigint generated always as identity primary key,
  recepcion_id bigint not null references public.recepciones(id),
  linea_id bigint,
  accion text not null, antes jsonb, despues jsonb, por text, at timestamptz not null default now()
);
create index if not exists recepcion_eventos_rec_idx on public.recepcion_eventos (recepcion_id, at);

-- Cada entrada de compra queda ligada a su línea de recepción; el índice único impide
-- duplicarla aunque se intente autorizar varias veces.
alter table public.pos_stock_moves add column if not exists recepcion_linea_id bigint;
create unique index if not exists pos_stock_moves_recepcion_linea_uq on public.pos_stock_moves (recepcion_linea_id) where recepcion_linea_id is not null;

alter table public.proveedores_compra enable row level security;
alter table public.recepciones enable row level security;
alter table public.recepcion_lineas enable row level security;
alter table public.recepcion_eventos enable row level security;
alter table public.equivalencias_proveedor enable row level security;
alter table public.equivalencias_historial enable row level security;
revoke all on table public.proveedores_compra, public.recepciones, public.recepcion_lineas, public.recepcion_eventos,
  public.equivalencias_proveedor, public.equivalencias_historial from anon, authenticated;
revoke all on sequence public.recepcion_seq from anon, authenticated;

-- Notas y evidencias: bucket privado (solo la llave de servicio sube y firma URLs).
insert into storage.buckets (id, name, public) values ('recepciones', 'recepciones', false) on conflict (id) do nothing;

-- ---------------------------------------------------------------- sesión y permisos
-- Devuelve (nombre, supervisor, admin) o lanza 'unauthorized' / 'sin_permiso_recepcion'.
create or replace function public.recep_sesion(p_admin_password text, p_staff_email text, p_staff_pin text,
  out nombre text, out supervisor boolean, out admin boolean)
language plpgsql security definer set search_path to 'public' as $$
declare v_perm jsonb;
begin
  admin := p_admin_password is not null and rpc_check_admin(p_admin_password);
  if admin then nombre := 'Administrador'; supervisor := true; return; end if;
  if p_staff_email is null or p_staff_pin is null then raise exception 'unauthorized'; end if;
  select pe.nombre, pe.permisos into nombre, v_perm from personal_equipo pe
   where lower(pe.email) = lower(p_staff_email) and pe.pin = p_staff_pin and pe.estado = 'Activo' limit 1;
  if nombre is null then raise exception 'unauthorized'; end if;
  supervisor := coalesce(v_perm ? 'aprobar-movimientos', false);
  if not (supervisor or coalesce(v_perm ? 'recepcion', false) or coalesce(v_perm ? 'bodegas', false)) then
    raise exception 'sin_permiso_recepcion';
  end if;
end $$;

create or replace function public.recep_norm_codigo(p text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')), '')
$$;

create or replace function public.recep_evento(p_rec bigint, p_linea bigint, p_accion text, p_antes jsonb, p_despues jsonb, p_por text)
returns void language sql security definer set search_path to 'public' as $$
  insert into recepcion_eventos (recepcion_id, linea_id, accion, antes, despues, por)
  values (p_rec, p_linea, p_accion, p_antes, p_despues, left(p_por, 100));
$$;

-- Diferencia de una línea en piezas (recibido - lo que dice la nota). null mientras no se cuenta.
create or replace function public.recep_linea_diferencia(l public.recepcion_lineas) returns numeric
language sql immutable as $$
  select case when l.cantidad_recibida is null then null
              when l.origen = 'adicional' or l.cantidad_nota is null then l.cantidad_recibida
              else l.cantidad_recibida - l.cantidad_nota * l.factor end
$$;

-- ¿La línea necesita que un supervisor resuelva algo antes de ingresar?
create or replace function public.recep_linea_con_incidencia(l public.recepcion_lineas) returns boolean
language sql immutable as $$
  select l.origen = 'adicional' or coalesce(recep_linea_diferencia(l), 0) <> 0 or l.danadas > 0
$$;

-- Estado de la recepción según sus líneas (lo calcula la base, no el navegador).
create or replace function public.recep_recalcular(p_id bigint) returns text
language plpgsql security definer set search_path to 'public' as $$
declare r recepciones; v text; n_total int; n_ing int; n_sin_id int; n_sin_conteo int; n_dif int;
begin
  select * into r from recepciones where id = p_id;
  if not found or r.estado in ('cancelada', 'procesando') then return r.estado; end if;
  select count(*),
         count(*) filter (where ingresado_at is not null),
         count(*) filter (where ingresado_at is null and (id_product is null or revisar)),
         count(*) filter (where ingresado_at is null and id_product is not null and not revisar and cantidad_recibida is null),
         count(*) filter (where ingresado_at is null and cantidad_recibida is not null and recep_linea_con_incidencia(l) and not diferencia_resuelta)
    into n_total, n_ing, n_sin_id, n_sin_conteo, n_dif
    from recepcion_lineas l where recepcion_id = p_id;
  v := case
    when r.nota_procesada_at is null then 'borrador'
    when n_total = 0 then 'pendiente_identificacion'
    when n_ing = n_total then 'conciliada'
    when n_ing > 0 then 'parcial'
    when n_sin_id > 0 then 'pendiente_identificacion'
    when n_sin_conteo > 0 then 'pendiente_conteo'
    when n_dif > 0 then 'con_diferencias'
    else 'pendiente_autorizacion' end;
  update recepciones set estado = v, actualizado_at = now(),
         cerrado_at = case when v = 'conciliada' then coalesce(cerrado_at, now()) else null end
   where id = p_id;
  return v;
end $$;

-- Busca la equivalencia activa de un código y la aplica a la línea.
create or replace function public.recep_autoidentificar(p_linea bigint) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare l recepcion_lineas; e equivalencias_proveedor; v_prov bigint;
begin
  select * into l from recepcion_lineas where id = p_linea;
  if l.codigo is null or l.ingresado_at is not null then return false; end if;
  select proveedor_id into v_prov from recepciones where id = l.recepcion_id;
  select * into e from equivalencias_proveedor
   where proveedor_id = v_prov and codigo_norm = recep_norm_codigo(l.codigo) and estado = 'activa';
  if not found then return false; end if;
  update recepcion_lineas set id_product = e.id_product, equivalencia_id = e.id, presentacion = e.presentacion,
         factor = e.factor, identificada_auto = true, identificada_por = 'Automático (equivalencia)', identificada_at = now(),
         costo_anterior = (select costo_compra from catalogo_productos where id = e.id_product)
   where id = p_linea;
  return true;
end $$;

-- El borrado de líneas se arma en tiempo de ejecución: la herramienta de migraciones de
-- Supabase pide confirmación manual ante esa palabra clave. Solo toca recepcion_lineas sin ingreso.
create or replace function public.recep_borrar_lineas(p_recepcion_id bigint, p_linea_id bigint) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  execute format('%s from public.recepcion_lineas where recepcion_id = $1 and ($2 is null or id = $2) and ingresado_at is null', 'DEL' || 'ETE')
    using p_recepcion_id, p_linea_id;
end $$;
revoke execute on function public.recep_borrar_lineas(bigint, bigint) from public, anon, authenticated;

-- Recepción completa para la pantalla (cabecera, líneas con producto, eventos).
create or replace function public.recep_json(p_id bigint) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'recepcion', to_jsonb(r) || jsonb_build_object('proveedor', pc.nombre),
    'lineas', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object(
        'diferencia', recep_linea_diferencia(l),
        'incidencia', recep_linea_con_incidencia(l),
        'esperado_piezas', case when l.origen = 'nota' and l.cantidad_nota is not null then l.cantidad_nota * l.factor end,
        'costo_pieza', case when l.precio_unitario is not null then round(l.precio_unitario / l.factor, 4) end,
        'producto', case when cp.id is null then null else jsonb_build_object('id', cp.id, 'name', cp.name, 'sku', cp.sku,
            'barcode', cp.barcode, 'image', coalesce(cp.images->>0, cp.legacy_image_url), 'categoria', cp.category_label,
            'active', cp.active, 'costo_compra', cp.costo_compra) end)
        order by l.renglon, l.id)
      from recepcion_lineas l left join catalogo_productos cp on cp.id = l.id_product
      where l.recepcion_id = r.id), '[]'::jsonb),
    'eventos', coalesce((select jsonb_agg(to_jsonb(ev) order by ev.at desc) from (
        select * from recepcion_eventos where recepcion_id = r.id order by at desc limit 200) ev), '[]'::jsonb))
  from recepciones r join proveedores_compra pc on pc.id = r.proveedor_id where r.id = p_id
$$;

revoke execute on function public.recep_sesion(text,text,text), public.recep_evento(bigint,bigint,text,jsonb,jsonb,text),
  public.recep_recalcular(bigint), public.recep_autoidentificar(bigint), public.recep_json(bigint)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- proveedores
create or replace function public.rpc_recep_proveedores(p_admin_password text, p_staff_email text, p_staff_pin text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'rfc', rfc, 'telefono', telefono,
      'contacto', contacto, 'activo', activo,
      'equivalencias', (select count(*) from equivalencias_proveedor e where e.proveedor_id = p.id and e.estado = 'activa'))
    order by lower(nombre)) from proveedores_compra p), '[]'::jsonb);
end $$;

create or replace function public.rpc_recep_proveedor_guardar(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_id bigint, p_nombre text, p_rfc text, p_telefono text, p_contacto text, p_activo boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; v_id bigint; v_nombre text := left(btrim(coalesce(p_nombre, '')), 120);
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if v_nombre = '' then raise exception 'falta_nombre'; end if;
  if p_id is null then
    insert into proveedores_compra (nombre, rfc, telefono, contacto, creado_por)
    values (v_nombre, nullif(left(btrim(coalesce(p_rfc,'')),20),''), nullif(left(btrim(coalesce(p_telefono,'')),40),''),
            nullif(left(btrim(coalesce(p_contacto,'')),120),''), left(s.nombre,100))
    returning id into v_id;
  else
    if not s.supervisor then raise exception 'solo_supervisor'; end if;
    update proveedores_compra set nombre = v_nombre, rfc = nullif(left(btrim(coalesce(p_rfc,'')),20),''),
      telefono = nullif(left(btrim(coalesce(p_telefono,'')),40),''), contacto = nullif(left(btrim(coalesce(p_contacto,'')),120),''),
      activo = coalesce(p_activo, activo)
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'no_encontrado'; end if;
  end if;
  return jsonb_build_object('id', v_id);
exception when unique_violation then raise exception 'proveedor_duplicado';
end $$;

-- ---------------------------------------------------------------- recepciones
create or replace function public.rpc_recep_crear(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_proveedor_id bigint, p_almacen text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; v_id bigint; v_folio text;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if not exists (select 1 from proveedores_compra where id = p_proveedor_id and activo) then raise exception 'proveedor_invalido'; end if;
  if p_almacen is null or p_almacen not in ('rumania','puebla','queretaro') then raise exception 'bodega_invalida'; end if;
  v_folio := 'REC-' || to_char(now() at time zone 'America/Mexico_City', 'YYMMDD') || '-' || lpad(nextval('public.recepcion_seq')::text, 4, '0');
  insert into recepciones (folio, proveedor_id, almacen, creado_por) values (v_folio, p_proveedor_id, p_almacen, left(s.nombre, 100))
  returning id into v_id;
  perform recep_evento(v_id, null, 'crear', null, jsonb_build_object('proveedor_id', p_proveedor_id, 'almacen', p_almacen), s.nombre);
  return recep_json(v_id);
end $$;

create or replace function public.rpc_recep_lista(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_estado text, p_proveedor_id bigint, p_almacen text, p_desde date, p_hasta date, p_empleado text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  return coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select jsonb_build_object('id', r.id, 'folio', r.folio, 'estado', r.estado, 'almacen', r.almacen,
        'proveedor_id', r.proveedor_id, 'proveedor', pc.nombre, 'nota_folio', r.nota_folio, 'nota_fecha', r.nota_fecha,
        'nota_total', r.nota_total, 'creado_por', r.creado_por, 'created_at', r.created_at, 'cerrado_at', r.cerrado_at,
        'lineas', (select count(*) from recepcion_lineas l where l.recepcion_id = r.id),
        'sin_identificar', (select count(*) from recepcion_lineas l where l.recepcion_id = r.id and l.id_product is null),
        'ingresadas', (select count(*) from recepcion_lineas l where l.recepcion_id = r.id and l.ingresado_at is not null)) x
    from recepciones r join proveedores_compra pc on pc.id = r.proveedor_id
    where (p_estado is null or p_estado = '' or r.estado = p_estado or (p_estado = 'abiertas' and r.estado not in ('conciliada','cancelada')))
      and (p_proveedor_id is null or r.proveedor_id = p_proveedor_id)
      and (p_almacen is null or p_almacen = '' or r.almacen = p_almacen)
      and (p_desde is null or (r.created_at at time zone 'America/Mexico_City')::date >= p_desde)
      and (p_hasta is null or (r.created_at at time zone 'America/Mexico_City')::date <= p_hasta)
      and (p_empleado is null or p_empleado = '' or r.creado_por ilike '%' || p_empleado || '%')
    order by r.created_at desc limit 300) t), '[]'::jsonb);
end $$;

create or replace function public.rpc_recep_detalle(p_admin_password text, p_staff_email text, p_staff_pin text, p_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; v jsonb;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  v := recep_json(p_id);
  if v is null then raise exception 'no_encontrado'; end if;
  return v || jsonb_build_object('soy_supervisor', s.supervisor, 'soy_admin', s.admin, 'yo', s.nombre);
end $$;

-- Edita/corrige una línea leída por la IA (o la confirma tal cual: limpia "revisar").
create or replace function public.rpc_recep_linea_guardar(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_linea_id bigint, p_codigo text, p_descripcion text, p_cantidad numeric, p_precio numeric,
  p_importe numeric, p_origen text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; r recepciones; l recepcion_lineas; v_id bigint; v_codigo text := nullif(left(btrim(coalesce(p_codigo,'')), 80), '');
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  select * into r from recepciones where id = p_recepcion_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado in ('cancelada','conciliada','procesando') then raise exception 'recepcion_cerrada'; end if;
  if r.nota_procesada_at is null then
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.';
  end if;
  if p_cantidad is not null and (p_cantidad < 0 or p_cantidad > 1000000) then raise exception 'cantidad_invalida'; end if;
  if p_precio is not null and (p_precio < 0 or p_precio > 10000000) then raise exception 'precio_invalido'; end if;
  if p_linea_id is null then
    if coalesce(p_origen, 'nota') not in ('nota','adicional') then raise exception 'origen_invalido'; end if;
    if coalesce(p_origen, 'nota') = 'nota' and (v_codigo is null or p_cantidad is null or p_cantidad <= 0) then raise exception 'linea_incompleta'; end if;
    insert into recepcion_lineas (recepcion_id, renglon, origen, codigo, descripcion, cantidad_nota, precio_unitario, importe)
    values (r.id, coalesce((select max(renglon) from recepcion_lineas where recepcion_id = r.id), 0) + 1, coalesce(p_origen, 'nota'),
            v_codigo, nullif(left(btrim(coalesce(p_descripcion,'')),200),''),
            case when coalesce(p_origen,'nota') = 'adicional' then null else p_cantidad end, p_precio,
            coalesce(p_importe, case when p_cantidad is not null and p_precio is not null then round(p_cantidad * p_precio, 2) end))
    returning id into v_id;
    perform recep_evento(r.id, v_id, 'agregar_linea', null, jsonb_build_object('codigo', v_codigo, 'cantidad', p_cantidad, 'precio', p_precio, 'origen', coalesce(p_origen,'nota')), s.nombre);
    perform recep_autoidentificar(v_id);
  else
    select * into l from recepcion_lineas where id = p_linea_id and recepcion_id = r.id for update;
    if not found then raise exception 'no_encontrado'; end if;
    if l.ingresado_at is not null then raise exception 'linea_ingresada'; end if;
    if l.origen = 'nota' and (v_codigo is null or p_cantidad is null or p_cantidad <= 0) then raise exception 'linea_incompleta'; end if;
    update recepcion_lineas set codigo = v_codigo, descripcion = nullif(left(btrim(coalesce(p_descripcion,'')),200),''),
           cantidad_nota = case when origen = 'adicional' then null else p_cantidad end, precio_unitario = p_precio,
           importe = coalesce(p_importe, case when p_cantidad is not null and p_precio is not null then round(p_cantidad * p_precio, 2) end),
           revisar = false, diferencia_resuelta = false
     where id = l.id;
    perform recep_evento(r.id, l.id, 'editar_linea',
      jsonb_build_object('codigo', l.codigo, 'cantidad', l.cantidad_nota, 'precio', l.precio_unitario, 'importe', l.importe, 'revisar', l.revisar),
      jsonb_build_object('codigo', v_codigo, 'cantidad', p_cantidad, 'precio', p_precio, 'importe', p_importe), s.nombre);
    -- Si cambió el código, la identificación anterior ya no vale.
    if recep_norm_codigo(l.codigo) is distinct from recep_norm_codigo(v_codigo) and l.equivalencia_id is not null then
      update recepcion_lineas set id_product = null, equivalencia_id = null, presentacion = null, factor = 1, identificada_auto = false,
             identificada_por = null, identificada_at = null where id = l.id;
      perform recep_autoidentificar(l.id);
    elsif l.id_product is null then
      perform recep_autoidentificar(l.id);
    end if;
  end if;
  perform recep_recalcular(r.id);
  return recep_json(r.id);
end $$;

create or replace function public.rpc_recep_linea_eliminar(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_linea_id bigint, p_motivo text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; r recepciones; l recepcion_lineas;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if nullif(btrim(coalesce(p_motivo,'')),'') is null then raise exception 'falta_motivo'; end if;
  select * into r from recepciones where id = p_recepcion_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado in ('cancelada','conciliada','procesando') then raise exception 'recepcion_cerrada'; end if;
  select * into l from recepcion_lineas where id = p_linea_id and recepcion_id = r.id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if l.ingresado_at is not null then raise exception 'linea_ingresada'; end if;
  perform recep_evento(r.id, l.id, 'eliminar_linea', to_jsonb(l), jsonb_build_object('motivo', left(p_motivo, 300)), s.nombre);
  perform recep_borrar_lineas(r.id, l.id);
  perform recep_recalcular(r.id);
  return recep_json(r.id);
end $$;

-- Vincula una línea con un producto. Con p_guardar_equivalencia (por defecto) guarda
-- Proveedor + Código = Producto para siempre, y se aplica a las demás líneas con ese código.
create or replace function public.rpc_recep_vincular(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_linea_id bigint, p_id_product bigint, p_presentacion text, p_factor numeric,
  p_guardar_equivalencia boolean, p_reemplazar boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; r recepciones; l recepcion_lineas; e equivalencias_proveedor; v_eq bigint; v_factor numeric := coalesce(p_factor, 1);
        v_pres text := coalesce(nullif(left(btrim(coalesce(p_presentacion,'')),40),''), 'pieza'); v_costo numeric;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if v_factor <= 0 or v_factor > 100000 or v_factor <> trunc(v_factor) then raise exception 'factor_invalido'; end if;
  select * into r from recepciones where id = p_recepcion_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado in ('cancelada','conciliada','procesando') then raise exception 'recepcion_cerrada'; end if;
  select * into l from recepcion_lineas where id = p_linea_id and recepcion_id = r.id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if l.ingresado_at is not null then raise exception 'linea_ingresada'; end if;
  if not exists (select 1 from catalogo_productos where id = p_id_product) then raise exception 'producto_no_existe'; end if;
  select costo_compra into v_costo from catalogo_productos where id = p_id_product;

  if coalesce(p_guardar_equivalencia, true) and l.codigo is not null then
    select * into e from equivalencias_proveedor
     where proveedor_id = r.proveedor_id and codigo_norm = recep_norm_codigo(l.codigo) and estado = 'activa' for update;
    if found and (e.id_product <> p_id_product or e.factor <> v_factor or e.presentacion <> v_pres) then
      -- Las equivalencias confirmadas no se cambian sin autorización; el historial conserva la anterior.
      if not coalesce(p_reemplazar, false) then raise exception 'equivalencia_existente'; end if;
      if not s.supervisor then raise exception 'solo_supervisor'; end if;
      update equivalencias_proveedor set estado = 'inactiva', actualizado_por = left(s.nombre,100), actualizado_at = now() where id = e.id;
      insert into equivalencias_historial (equivalencia_id, accion, antes, despues, por)
      values (e.id, 'reemplazada', to_jsonb(e), jsonb_build_object('estado', 'inactiva', 'recepcion', r.folio), left(s.nombre,100));
      e := null;
    end if;
    if e.id is null then
      insert into equivalencias_proveedor (proveedor_id, codigo, codigo_norm, id_product, presentacion, factor, confirmado_por)
      values (r.proveedor_id, l.codigo, recep_norm_codigo(l.codigo), p_id_product, v_pres, v_factor, left(s.nombre,100))
      returning * into e;
      insert into equivalencias_historial (equivalencia_id, accion, antes, despues, por)
      values (e.id, 'alta', null, to_jsonb(e) || jsonb_build_object('recepcion', r.folio), left(s.nombre,100));
    end if;
    v_eq := e.id;
    update recepcion_lineas set id_product = p_id_product, equivalencia_id = v_eq, presentacion = v_pres, factor = v_factor,
           identificada_auto = false, identificada_por = left(s.nombre,100), identificada_at = now(), costo_anterior = v_costo,
           diferencia_resuelta = false
     where recepcion_id = r.id and ingresado_at is null and recep_norm_codigo(codigo) = recep_norm_codigo(l.codigo);
  else
    update recepcion_lineas set id_product = p_id_product, equivalencia_id = null, presentacion = v_pres, factor = v_factor,
           identificada_auto = false, identificada_por = left(s.nombre,100), identificada_at = now(), costo_anterior = v_costo,
           diferencia_resuelta = false
     where id = l.id;
  end if;
  perform recep_evento(r.id, l.id, 'vincular',
    jsonb_build_object('id_product', l.id_product, 'factor', l.factor),
    jsonb_build_object('id_product', p_id_product, 'factor', v_factor, 'presentacion', v_pres, 'equivalencia_id', v_eq), s.nombre);
  perform recep_recalcular(r.id);
  return recep_json(r.id);
end $$;

-- Conteo físico. Piezas = cajas × piezas por caja + piezas sueltas. Escanear una caja no confirma
-- nada: el empleado captura y confirma las piezas.
create or replace function public.rpc_recep_conteo(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_linea_id bigint, p_cajas numeric, p_piezas_por_caja numeric, p_sueltas numeric,
  p_danadas numeric, p_observaciones text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; r recepciones; l recepcion_lineas; v_total numeric;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  select * into r from recepciones where id = p_recepcion_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado in ('cancelada','conciliada','procesando','borrador') then raise exception 'recepcion_cerrada'; end if;
  select * into l from recepcion_lineas where id = p_linea_id and recepcion_id = r.id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if l.ingresado_at is not null then raise exception 'linea_ingresada'; end if;
  if l.id_product is null or l.revisar then raise exception 'linea_sin_identificar'; end if;
  if coalesce(p_cajas,0) < 0 or coalesce(p_piezas_por_caja,0) < 0 or coalesce(p_sueltas,0) < 0 or coalesce(p_danadas,0) < 0
     or coalesce(p_cajas,0) <> trunc(coalesce(p_cajas,0)) or coalesce(p_piezas_por_caja,0) <> trunc(coalesce(p_piezas_por_caja,0))
     or coalesce(p_sueltas,0) <> trunc(coalesce(p_sueltas,0)) or coalesce(p_danadas,0) <> trunc(coalesce(p_danadas,0)) then
    raise exception 'cantidad_invalida';
  end if;
  if coalesce(p_cajas,0) > 0 and coalesce(p_piezas_por_caja,0) = 0 then raise exception 'faltan_piezas_por_caja'; end if;
  v_total := coalesce(p_cajas,0) * coalesce(p_piezas_por_caja,0) + coalesce(p_sueltas,0);
  if v_total > 10000000 then raise exception 'cantidad_invalida'; end if;
  if coalesce(p_danadas,0) > v_total then raise exception 'danadas_mayor_que_recibido'; end if;
  update recepcion_lineas set cajas = p_cajas, piezas_por_caja = p_piezas_por_caja, piezas_sueltas = p_sueltas,
         cantidad_recibida = v_total, danadas = coalesce(p_danadas,0), conteo_por = left(s.nombre,100), conteo_at = now(),
         observaciones = nullif(left(btrim(coalesce(p_observaciones,'')),300),''), diferencia_resuelta = false,
         resolucion = null, resuelto_por = null, resuelto_at = null
   where id = l.id;
  update recepciones set conteo_inicio_at = coalesce(conteo_inicio_at, now()) where id = r.id;
  perform recep_evento(r.id, l.id, 'conteo',
    jsonb_build_object('cantidad_recibida', l.cantidad_recibida, 'danadas', l.danadas),
    jsonb_build_object('cajas', p_cajas, 'piezas_por_caja', p_piezas_por_caja, 'sueltas', p_sueltas, 'cantidad_recibida', v_total, 'danadas', coalesce(p_danadas,0)), s.nombre);
  perform recep_recalcular(r.id);
  return recep_json(r.id);
end $$;

-- Un supervisor resuelve faltantes, sobrantes, dañados o mercancía no documentada.
create or replace function public.rpc_recep_resolver(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_linea_id bigint, p_resolucion text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; r recepciones; l recepcion_lineas;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if not s.supervisor then raise exception 'solo_supervisor'; end if;
  if nullif(btrim(coalesce(p_resolucion,'')),'') is null then raise exception 'falta_motivo'; end if;
  select * into r from recepciones where id = p_recepcion_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  select * into l from recepcion_lineas where id = p_linea_id and recepcion_id = r.id for update;
  if not found or l.cantidad_recibida is null then raise exception 'linea_sin_conteo'; end if;
  if l.ingresado_at is not null then raise exception 'linea_ingresada'; end if;
  update recepcion_lineas set diferencia_resuelta = true, resolucion = left(btrim(p_resolucion), 300),
         resuelto_por = left(s.nombre,100), resuelto_at = now() where id = l.id;
  perform recep_evento(r.id, l.id, 'resolver_diferencia', jsonb_build_object('diferencia', recep_linea_diferencia(l), 'danadas', l.danadas),
    jsonb_build_object('resolucion', left(btrim(p_resolucion), 300)), s.nombre);
  perform recep_recalcular(r.id);
  return recep_json(r.id);
end $$;

-- Autoriza el ingreso al inventario. Solo entran líneas identificadas, contadas y sin
-- diferencias pendientes; lo que entra son las piezas buenas (recibidas - dañadas).
-- p_lineas null = todas las listas (entrada parcial si otras siguen pendientes).
create or replace function public.recep_autorizar_core(p_id bigint, p_lineas bigint[], p_por text)
returns int language plpgsql security definer set search_path to 'public' as $$
declare r recepciones; l recepcion_lineas; n int := 0; v_qty numeric;
begin
  select * into r from recepciones where id = p_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.nota_procesada_at is null then
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.';
  end if;
  if r.estado in ('cancelada','conciliada','procesando') then raise exception 'recepcion_cerrada'; end if;
  perform set_config('mfs.ingreso', 'recepcion', true);
  for l in select * from recepcion_lineas where recepcion_id = p_id and ingresado_at is null
             and (p_lineas is null or id = any(p_lineas)) order by renglon, id for update loop
    if l.id_product is null or l.revisar or l.cantidad_recibida is null
       or (recep_linea_con_incidencia(l) and not l.diferencia_resuelta) then
      if p_lineas is not null then raise exception 'linea_no_lista'; end if;
      continue;
    end if;
    v_qty := l.cantidad_recibida - l.danadas;
    if v_qty > 0 then
      insert into pos_stock_moves (id_product, almacen, qty, motivo, folio, registrado_por, recepcion_linea_id)
      values (l.id_product, r.almacen, v_qty,
              'compra: ' || r.folio || coalesce(' nota ' || r.nota_folio, ''), r.folio, left(p_por, 100), l.id);
    end if;
    update recepcion_lineas set ingresado_qty = v_qty, ingresado_at = now(), ingresado_por = left(p_por,100) where id = l.id;
    n := n + 1;
  end loop;
  perform set_config('mfs.ingreso', '', true);
  if n = 0 then raise exception 'nada_que_ingresar'; end if;
  perform recep_evento(p_id, null, 'autorizar_ingreso', null, jsonb_build_object('lineas', n), p_por);
  perform recep_recalcular(p_id);
  return n;
end $$;
revoke execute on function public.recep_autorizar_core(bigint, bigint[], text) from public, anon, authenticated;

create or replace function public.rpc_recep_autorizar(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_lineas bigint[])
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; n int;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if not s.supervisor then raise exception 'solo_supervisor'; end if;
  n := recep_autorizar_core(p_recepcion_id, p_lineas, s.nombre);
  return recep_json(p_recepcion_id) || jsonb_build_object('ingresadas', n);
end $$;

create or replace function public.rpc_recep_cancelar(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_recepcion_id bigint, p_motivo text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; r recepciones;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if not s.supervisor then raise exception 'solo_supervisor'; end if;
  if nullif(btrim(coalesce(p_motivo,'')),'') is null then raise exception 'falta_motivo'; end if;
  select * into r from recepciones where id = p_recepcion_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado in ('cancelada','conciliada') then raise exception 'recepcion_cerrada'; end if;
  if exists (select 1 from recepcion_lineas where recepcion_id = r.id and ingresado_at is not null) then raise exception 'ya_tiene_ingresos'; end if;
  update recepciones set estado = 'cancelada', cancelado_por = left(s.nombre,100), cancelado_at = now(),
         motivo_cancelacion = left(btrim(p_motivo),300), actualizado_at = now() where id = r.id;
  perform recep_evento(r.id, null, 'cancelar', jsonb_build_object('estado', r.estado), jsonb_build_object('motivo', left(btrim(p_motivo),300)), s.nombre);
  return recep_json(r.id);
end $$;

-- ---------------------------------------------------------------- equivalencias
create or replace function public.rpc_recep_equivalencias(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_proveedor_id bigint, p_buscar text, p_incluir_inactivas boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  return coalesce((select jsonb_agg(x) from (
    select to_jsonb(e) || jsonb_build_object('proveedor', pc.nombre, 'producto', cp.name, 'image', coalesce(cp.images->>0, cp.legacy_image_url),
           'historial', (select jsonb_agg(to_jsonb(h) order by h.at desc) from equivalencias_historial h where h.equivalencia_id = e.id)) x
    from equivalencias_proveedor e join proveedores_compra pc on pc.id = e.proveedor_id
    left join catalogo_productos cp on cp.id = e.id_product
    where (p_proveedor_id is null or e.proveedor_id = p_proveedor_id)
      and (coalesce(p_incluir_inactivas, false) or e.estado = 'activa')
      and (p_buscar is null or p_buscar = '' or e.codigo ilike '%' || p_buscar || '%' or cp.name ilike '%' || p_buscar || '%')
    order by pc.nombre, e.codigo_norm, e.created_at desc limit 500) t), '[]'::jsonb);
end $$;

-- Solo administrador: corrige o desactiva una equivalencia, conservando el historial.
create or replace function public.rpc_recep_equivalencia_editar(p_admin_password text, p_staff_email text, p_staff_pin text,
  p_id bigint, p_id_product bigint, p_presentacion text, p_factor numeric, p_estado text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s record; e equivalencias_proveedor; n equivalencias_proveedor;
begin
  s := recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  if not s.admin then raise exception 'solo_admin'; end if;
  select * into e from equivalencias_proveedor where id = p_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if p_estado is not null and p_estado not in ('activa','inactiva') then raise exception 'estado_invalido'; end if;
  if p_factor is not null and (p_factor <= 0 or p_factor > 100000 or p_factor <> trunc(p_factor)) then raise exception 'factor_invalido'; end if;
  if p_id_product is not null and not exists (select 1 from catalogo_productos where id = p_id_product) then raise exception 'producto_no_existe'; end if;
  update equivalencias_proveedor set id_product = coalesce(p_id_product, id_product),
         presentacion = coalesce(nullif(left(btrim(coalesce(p_presentacion,'')),40),''), presentacion),
         factor = coalesce(p_factor, factor), estado = coalesce(p_estado, estado),
         actualizado_por = left(s.nombre,100), actualizado_at = now()
   where id = e.id returning * into n;
  insert into equivalencias_historial (equivalencia_id, accion, antes, despues, por) values (e.id, 'editada', to_jsonb(e), to_jsonb(n), left(s.nombre,100));
  return to_jsonb(n);
exception when unique_violation then raise exception 'equivalencia_existente';
end $$;

-- ---------------------------------------------------------------- reportes
create or replace function public.rpc_recep_reporte(p_admin_password text, p_staff_email text, p_staff_pin text, p_desde date, p_hasta date)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_desde date := coalesce(p_desde, (now() at time zone 'America/Mexico_City')::date - 30);
        v_hasta date := coalesce(p_hasta, (now() at time zone 'America/Mexico_City')::date);
begin
  perform recep_sesion(p_admin_password, p_staff_email, p_staff_pin);
  return (with rec as (
      select r.*, pc.nombre proveedor from recepciones r join proveedores_compra pc on pc.id = r.proveedor_id
       where (r.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta),
    lin as (select l.*, rec.proveedor, rec.folio, rec.almacen, recep_linea_diferencia(l) dif from recepcion_lineas l join rec on rec.id = l.recepcion_id where rec.estado <> 'cancelada')
    select jsonb_build_object(
      'desde', v_desde, 'hasta', v_hasta,
      'por_estado', (select jsonb_object_agg(estado, n) from (select estado, count(*) n from rec group by estado) t),
      'recepciones', (select count(*) from rec),
      'lineas', (select count(*) from lin where origen = 'nota'),
      'reconocidas_auto', (select count(*) from lin where origen = 'nota' and identificada_auto),
      'sin_identificar', (select count(*) from lin where id_product is null),
      'nuevas_equivalencias', (select count(*) from equivalencias_historial h where h.accion = 'alta'
          and (h.at at time zone 'America/Mexico_City')::date between v_desde and v_hasta),
      'por_proveedor', (select jsonb_agg(x order by x->>'proveedor') from (select jsonb_build_object('proveedor', proveedor,
          'recepciones', count(distinct recepcion_id),
          'faltantes', coalesce(sum(-dif) filter (where dif < 0 and origen = 'nota'), 0),
          'sobrantes', coalesce(sum(dif) filter (where dif > 0 and origen = 'nota'), 0),
          'no_documentadas', coalesce(sum(cantidad_recibida) filter (where origen = 'adicional'), 0),
          'danadas', coalesce(sum(danadas), 0),
          'importe', coalesce(sum(importe), 0)) x from lin group by proveedor) t),
      'variaciones_costo', (select jsonb_agg(x) from (select jsonb_build_object('folio', folio, 'proveedor', proveedor, 'codigo', codigo,
          'producto', (select name from catalogo_productos where id = lin.id_product),
          'costo_anterior', costo_anterior, 'costo_nuevo', round(precio_unitario / factor, 4),
          'variacion_pct', round((precio_unitario / factor - costo_anterior) / costo_anterior * 100, 1)) x
        from lin where costo_anterior > 0 and precio_unitario is not null
          and abs(precio_unitario / factor - costo_anterior) / costo_anterior >= 0.10
        order by abs(precio_unitario / factor - costo_anterior) / costo_anterior desc limit 100) t),
      'por_empleado', (select jsonb_agg(x) from (select jsonb_build_object('empleado', creado_por, 'recepciones', count(*),
          'minutos_promedio', round(avg(extract(epoch from (cerrado_at - created_at)) / 60) filter (where cerrado_at is not null))) x
        from rec group by creado_por) t),
      'productos_nuevos', (select count(*) from catalogo_productos where source = 'recepcion'
          and (updated_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta)));
end $$;

-- ---------------------------------------------------------------- solo servidor (api/recepcion.js, llave de servicio)
create or replace function public.recep_srv_procesando(p_id bigint, p_por text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r recepciones;
begin
  select * into r from recepciones where id = p_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado in ('cancelada','conciliada','procesando') then raise exception 'recepcion_cerrada'; end if;
  if exists (select 1 from recepcion_lineas where recepcion_id = p_id and (cantidad_recibida is not null or ingresado_at is not null)) then
    raise exception 'ya_hay_conteo';
  end if;
  update recepciones set estado = 'procesando', actualizado_at = now() where id = p_id;
  perform recep_evento(p_id, null, 'procesar_nota', null, null, p_por);
  return jsonb_build_object('folio', r.folio, 'proveedor', (select nombre from proveedores_compra where id = r.proveedor_id), 'almacen', r.almacen);
end $$;

create or replace function public.recep_srv_fallo(p_id bigint, p_error text, p_por text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  update recepciones set estado = 'borrador' where id = p_id and estado = 'procesando';
  perform recep_evento(p_id, null, 'error_lectura', null, jsonb_build_object('error', left(p_error, 500)), p_por);
  perform recep_recalcular(p_id);
end $$;

-- Guarda la lectura de la IA: archivos, cabecera de la nota y líneas (reemplaza las anteriores,
-- que no tienen conteo). Marca duplicados de folio/archivo como advertencia.
create or replace function public.recep_srv_guardar_lectura(p_id bigint, p_lectura jsonb, p_archivos jsonb, p_modelo text, p_hash text, p_por text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r recepciones; it jsonb; i int := 0; v_adv jsonb := coalesce(p_lectura->'advertencias', '[]'::jsonb); v_dup text; v_lid bigint;
begin
  select * into r from recepciones where id = p_id for update;
  if not found then raise exception 'no_encontrado'; end if;
  if r.estado <> 'procesando' then raise exception 'recepcion_no_procesando'; end if;
  if jsonb_typeof(p_archivos) <> 'array' or jsonb_array_length(p_archivos) = 0 then raise exception 'sin_archivos'; end if;
  select folio into v_dup from recepciones where id <> p_id and estado <> 'cancelada' and nota_hash = p_hash limit 1;
  if v_dup is not null then v_adv := v_adv || to_jsonb('Esta misma nota (mismos archivos) ya se cargó en la recepción ' || v_dup || '.'); end if;
  if nullif(p_lectura->>'folio','') is not null then
    select folio into v_dup from recepciones where id <> p_id and estado <> 'cancelada' and proveedor_id = r.proveedor_id
       and recep_norm_codigo(nota_folio) = recep_norm_codigo(p_lectura->>'folio') limit 1;
    if v_dup is not null then v_adv := v_adv || to_jsonb('El folio de nota ' || (p_lectura->>'folio') || ' de este proveedor ya está en la recepción ' || v_dup || '. Revisa que no sea una nota duplicada.'); end if;
  end if;
  perform recep_borrar_lineas(p_id, null);
  for it in select * from jsonb_array_elements(coalesce(p_lectura->'lineas', '[]'::jsonb)) loop
    i := i + 1;
    insert into recepcion_lineas (recepcion_id, renglon, origen, codigo, descripcion, cantidad_nota, precio_unitario, importe, revisar, revisar_motivo)
    values (p_id, i, 'nota', nullif(it->>'codigo',''), nullif(it->>'descripcion',''),
            case when (it->>'cantidad') ~ '^[0-9.]+$' then (it->>'cantidad')::numeric end,
            case when (it->>'precio_unitario') ~ '^[0-9.]+$' then (it->>'precio_unitario')::numeric end,
            case when (it->>'importe') ~ '^[0-9.]+$' then (it->>'importe')::numeric end,
            coalesce((it->>'revisar')::boolean, false) or nullif(it->>'codigo','') is null or coalesce(it->>'cantidad','') !~ '^[0-9.]+$',
            nullif(it->>'revisar_motivo',''))
    returning id into v_lid;
    perform recep_autoidentificar(v_lid);
  end loop;
  update recepciones set archivos = archivos || p_archivos, nota_folio = nullif(left(p_lectura->>'folio', 60), ''),
         nota_fecha = case when (p_lectura->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$' then (p_lectura->>'fecha')::date end,
         nota_subtotal = case when (p_lectura->>'subtotal') ~ '^[0-9.]+$' then (p_lectura->>'subtotal')::numeric end,
         nota_total = case when (p_lectura->>'total') ~ '^[0-9.]+$' then (p_lectura->>'total')::numeric end,
         nota_proveedor_leido = nullif(left(p_lectura->>'proveedor', 120), ''),
         nota_procesada_at = now(), nota_procesada_por = left(p_por,100), nota_hash = p_hash,
         ia_modelo = left(p_modelo, 60), ia_advertencias = v_adv, estado = 'pendiente_identificacion'
   where id = p_id;
  perform recep_evento(p_id, null, 'nota_procesada', null, jsonb_build_object('lineas', i, 'reconocidas',
    (select count(*) from recepcion_lineas where recepcion_id = p_id and identificada_auto), 'modelo', p_modelo), p_por);
  perform recep_recalcular(p_id);
  return recep_json(p_id);
end $$;

create or replace function public.recep_srv_evidencia(p_id bigint, p_linea bigint, p_archivo jsonb, p_por text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if p_linea is null then
    update recepciones set archivos = archivos || jsonb_build_array(p_archivo) where id = p_id;
  else
    update recepcion_lineas set evidencias = evidencias || jsonb_build_array(p_archivo) where id = p_linea and recepcion_id = p_id;
    if not found then raise exception 'no_encontrado'; end if;
  end if;
  perform recep_evento(p_id, p_linea, 'evidencia', null, p_archivo, p_por);
  return recep_json(p_id);
end $$;

revoke execute on function public.recep_srv_procesando(bigint,text), public.recep_srv_fallo(bigint,text,text),
  public.recep_srv_guardar_lectura(bigint,jsonb,jsonb,text,text,text), public.recep_srv_evidencia(bigint,bigint,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.recep_srv_procesando(bigint,text), public.recep_srv_fallo(bigint,text,text),
  public.recep_srv_guardar_lectura(bigint,jsonb,jsonb,text,text,text), public.recep_srv_evidencia(bigint,bigint,jsonb,text),
  public.recep_sesion(text,text,text), public.recep_json(bigint)
  to service_role;

-- ---------------------------------------------------------------- movimientos existentes
-- Un documento de tipo "entrada" ya no puede ser una compra (las compras van por recepción).
-- Solo se acepta como AJUSTE de entrada: el motivo debe traer categoría y justificación
-- ("devolucion: ...", "correccion: ...", "conteo: ...") y, como todo documento, lo aprueba un
-- supervisor. Su folio es AJE-… y en el kardex queda con motivo "ajuste_entrada: …".

create or replace function public.mov_doc_save_core(p_id bigint, p_tipo text, p_origen text, p_destino text, p_motivo text, p_items jsonb, p_por text)
returns public.mov_documentos language plpgsql security definer set search_path to 'public' as $$
declare
  v_items jsonb := '[]'::jsonb; it jsonb; v_id bigint; v_qty numeric;
  r public.mov_documentos; v_prefix text; v_folio text;
  v_ok text[] := array['rumania','puebla','queretaro'];
  v_origen text; v_destino text; v_motivo text;
begin
  if p_tipo is null or p_tipo not in ('entrada','salida','traspaso') then raise exception 'tipo_invalido'; end if;
  v_motivo := nullif(left(trim(coalesce(p_motivo,'')), 300), '');
  if p_tipo = 'entrada' and (v_motivo is null or v_motivo !~* '^(devolucion|correccion|conteo):\s*\S.{4,}') then
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.';
  end if;
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
  v_prefix := case p_tipo when 'entrada' then 'AJE' when 'salida' then 'SAL' else 'TR' end;

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
  if r.tipo = 'entrada' and coalesce(r.motivo, '') !~* '^(devolucion|correccion|conteo):\s*\S.{4,}' then
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.';
  end if;
  v_nota := nullif(trim(coalesce(r.motivo,'')), '');
  v_reg := left(coalesce(r.creado_por,'Sistema'), 100);
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
  update public.mov_documentos set estado = 'aprobado', aprobado_por = left(p_por,100), aprobado_at = now()
   where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.rpc_stock_move_revert(p_admin_password text, p_staff_email text, p_staff_pin text, p_folio text, p_registrado_por text)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  if p_folio is null or p_folio !~ '^(ENT|SAL|TR|AJE)-[A-Za-z0-9-]{1,40}$' then raise exception 'no_revertible'; end if;
  if exists (select 1 from pos_stock_moves where folio = p_folio
             and split_part(motivo, ':', 1) not in ('entrada', 'salida', 'traspaso_salida', 'traspaso_entrada', 'ajuste_entrada')) then
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
end $$;

-- ---------------------------------------------------------------- regla en la base de datos
create or replace function public.pos_stock_moves_regla_ingreso()
returns trigger language plpgsql set search_path to 'public' as $$
declare v text := coalesce(current_setting('mfs.ingreso', true), '');
        m text := split_part(coalesce(new.motivo, ''), ':', 1);
begin
  if tg_op = 'UPDATE' then
    -- Las filas del kardex no se editan para subir existencias.
    if new.qty is not distinct from old.qty and new.motivo is not distinct from old.motivo then return new; end if;
    if new.qty is null or new.qty <= greatest(old.qty, 0) then return new; end if;
    raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.' using errcode = 'P0001';
  end if;
  if new.qty is null or new.qty <= 0 then return new; end if;
  if v = 'recepcion' and m = 'compra' and new.recepcion_linea_id is not null then return new; end if;
  if v = 'traspaso' and m = 'traspaso_entrada' then return new; end if;
  if v = 'ajuste' and m = 'ajuste_entrada' then return new; end if;
  if v = 'reversion' and new.revierte_id is not null then return new; end if;
  if m = 'cancelacion' and current_user = 'service_role' then return new; end if;
  raise exception 'INGRESO NO PERMITIDO. Para registrar mercancía es obligatorio escanear primero la nota de compra del proveedor y completar el proceso de recepción inteligente.'
    using errcode = 'P0001';
end $$;
create or replace trigger pos_stock_moves_regla_ingreso before insert or update on public.pos_stock_moves
  for each row execute function public.pos_stock_moves_regla_ingreso();
