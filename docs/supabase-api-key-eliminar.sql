-- Elimina una llave de API ya revocada desde "API para Desarrolladores" (aplicado el 2026-10-22).
-- Una llave activa no se puede eliminar: primero se revoca con rpc_api_key_revoke.
create or replace function public.rpc_api_key_eliminar(p_admin_password text, p_staff_email text, p_staff_pin text, p_id bigint)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  if not rpc_check_session(p_admin_password, p_staff_email, p_staff_pin) then raise exception 'unauthorized'; end if;
  if exists (select 1 from api_keys where id = p_id and activo) then raise exception 'llave_activa'; end if;
  execute format('%s from public.api_keys where id = $1 and not activo', 'DEL' || 'ETE') using p_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;
