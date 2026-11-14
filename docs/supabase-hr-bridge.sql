-- Configuración privada del puente Mi Fiesta Shop -> HR PRO (check-in obligatorio, api/hr-checkin.js).
-- Solo la lee service_role (RLS activo sin políticas). La llave (hrck_…) se carga aparte, no va en el repo.
create table if not exists public.hr_bridge_config (
  id int primary key default 1 check (id = 1),
  hr_base_url text not null default 'https://asistencia-y62m.vercel.app',
  hr_checkin_key text,
  updated_at timestamptz not null default now()
);
alter table public.hr_bridge_config enable row level security;
revoke all on public.hr_bridge_config from anon, authenticated;
