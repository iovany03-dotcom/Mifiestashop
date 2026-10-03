-- Direcciones de clientes copiadas de PrestaShop. La tabla ps_direcciones ya existía (carga inicial
-- de septiembre, con las columnas de PrestaShop: firstname, address1, postcode, id_state…).
-- Este script solo AGREGA lo que faltaba — no borra ni cambia datos existentes:
--   * columnas para el nombre del estado/país (PrestaShop solo manda el id), la fecha de alta y la
--     referencia ("other"), que llena el sync (lib/sync-prestashop.js, dominio "direcciones");
--   * la vista direcciones_clientes: une cada dirección con su cliente de ps_clientes (la
--     instalación de PrestaShop es compartida con otras tiendas y la tabla trae direcciones de
--     clientes que no son de esta tienda; la vista deja solo las de nuestros clientes).
-- Datos personales: RLS activado y sin políticas en ps_direcciones; la vista usa security_invoker y
-- se le quita el acceso a anon/authenticated. Solo la llave de servicio (API de Vercel, tras validar
-- la sesión del admin/personal) puede leerla.
alter table public.ps_direcciones
  add column if not exists estado text,
  add column if not exists pais text,
  add column if not exists date_add timestamptz,
  add column if not exists referencia text;

create index if not exists ps_direcciones_customer_idx on public.ps_direcciones (id_customer);

create or replace view public.direcciones_clientes with (security_invoker = true) as
select d.id, d.id_customer,
       c.name as cliente_nombre, c.email as cliente_email,
       d.alias,
       nullif(trim(coalesce(d.firstname, '') || ' ' || coalesce(d.lastname, '')), '') as nombre,
       d.company as empresa,
       d.address1 as direccion, d.address2 as direccion2,
       d.postcode as cp, d.city as ciudad,
       d.estado, d.pais, d.id_state, d.id_country,
       d.phone as telefono, d.phone_mobile as celular,
       coalesce(nullif(d.vat_number, ''), nullif(d.dni, '')) as rfc,
       d.referencia,
       d.deleted as eliminada,
       d.date_add, d.date_upd
from public.ps_direcciones d
join public.ps_clientes c on c.id = d.id_customer;

revoke all on public.direcciones_clientes from public, anon, authenticated;
grant select on public.direcciones_clientes to service_role;
