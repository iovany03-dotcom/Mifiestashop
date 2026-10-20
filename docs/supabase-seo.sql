-- Módulo SEO (aplicado en Supabase el 2026-10-20, migración "seo_modulo"). Referencia para
-- recrearlo. Servidor: api/seo.js (panel) y api/cron-seo.js (cada hora); lógica en lib/seo-*.js.
-- Todas las tablas son privadas: solo la llave de servicio (Vercel) lee y escribe.

create table if not exists public.seo_auditorias (      -- última auditoría de cada URL del sitio
  url text primary key, tipo text, puntaje int not null,
  problemas jsonb not null default '[]'::jsonb, datos jsonb not null default '{}'::jsonb,
  auditado_at timestamptz not null default now()
);
create index if not exists seo_auditorias_puntaje_idx on public.seo_auditorias (puntaje, auditado_at);

create table if not exists public.seo_historial (       -- una foto por día (tendencia)
  fecha date primary key, puntaje_paginas numeric, paginas int, puntaje_productos numeric, productos int,
  clics int, impresiones int, posicion numeric, detalle jsonb not null default '{}'::jsonb
);

create table if not exists public.seo_gsc_diario (      -- Search Console por día, búsqueda y página
  fecha date not null, consulta text not null, pagina text not null,
  clics int not null default 0, impresiones int not null default 0, ctr numeric, posicion numeric,
  primary key (fecha, consulta, pagina)
);
create index if not exists seo_gsc_diario_consulta_idx on public.seo_gsc_diario (consulta, fecha);

create table if not exists public.seo_keywords (        -- palabras clave que se siguen
  keyword text primary key, url_objetivo text, creado_por text, created_at timestamptz not null default now()
);

create table if not exists public.seo_pagespeed (       -- mediciones de PageSpeed Insights
  id bigint generated always as identity primary key,
  url text not null, estrategia text not null check (estrategia in ('mobile','desktop')),
  medido_at timestamptz not null default now(),
  performance int, seo int, accesibilidad int, buenas_practicas int,
  lcp_ms int, cls numeric, tbt_ms int, fcp_ms int, si_ms int, detalle jsonb not null default '{}'::jsonb
);
create index if not exists seo_pagespeed_url_idx on public.seo_pagespeed (url, estrategia, medido_at desc);

alter table public.seo_auditorias enable row level security;
alter table public.seo_historial enable row level security;
alter table public.seo_gsc_diario enable row level security;
alter table public.seo_keywords enable row level security;
alter table public.seo_pagespeed enable row level security;
revoke all on table public.seo_auditorias, public.seo_historial, public.seo_gsc_diario, public.seo_keywords, public.seo_pagespeed from anon, authenticated;

-- Quién puede usar el módulo: el administrador o personal con permiso 'seo' / 'param-tienda-seo'.
create or replace function public.seo_sesion(p_admin_password text, p_staff_email text, p_staff_pin text,
  out nombre text, out permitido boolean)
language plpgsql security definer set search_path to 'public' as $$
declare v_perm jsonb;
begin
  permitido := false;
  if p_admin_password is not null and rpc_check_admin(p_admin_password) then nombre := 'Administrador'; permitido := true; return; end if;
  if p_staff_email is null or p_staff_pin is null then return; end if;
  select pe.nombre, pe.permisos into nombre, v_perm from personal_equipo pe
   where lower(pe.email) = lower(p_staff_email) and pe.pin = p_staff_pin and pe.estado = 'Activo' limit 1;
  permitido := nombre is not null and (coalesce(v_perm ? 'seo', false) or coalesce(v_perm ? 'param-tienda-seo', false));
end $$;
revoke execute on function public.seo_sesion(text,text,text) from public, anon, authenticated;
grant execute on function public.seo_sesion(text,text,text) to service_role;
