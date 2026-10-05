-- Blog (api/blog.js, api/blog-admin.js, lib/blog.js). Aplicado el 4 de octubre de 2026.
-- RLS sin políticas: solo la llave de servicio (API de Vercel) lee y escribe; las páginas públicas
-- muestran únicamente los artículos con estado 'publicado' y fecha ya cumplida.
create table if not exists public.blog_posts (
  id bigserial primary key,
  slug text not null unique,
  titulo text not null,
  resumen text,
  contenido text not null default '',
  imagen text,
  imagen_alt text,
  meta_title text,
  meta_description text,
  palabra_clave text,
  etiquetas text[] not null default '{}',
  autor text,
  estado text not null default 'borrador' check (estado in ('borrador','publicado')),
  publicado_at timestamptz,
  creado_por text,
  actualizado_por text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists blog_posts_publicados_idx on public.blog_posts (estado, publicado_at desc);
alter table public.blog_posts enable row level security;
revoke all on public.blog_posts from public, anon, authenticated;
grant select, insert, update, delete on public.blog_posts to service_role;
grant usage, select on sequence public.blog_posts_id_seq to service_role;
