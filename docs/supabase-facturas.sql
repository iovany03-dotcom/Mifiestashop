-- Facturas CFDI emitidas con Facturama (api/facturama.js). Solo se toca con la llave de servicio
-- (RLS activado y sin policies: el navegador nunca la lee directo).
create table if not exists facturas (
  id bigserial primary key,
  facturama_id text not null unique,          -- Id interno de Facturama (para PDF/XML/cancelar)
  uuid text,                                   -- folio fiscal (SAT)
  folio text not null,                         -- Folio enviado a Facturama (idempotencia)
  serie text,
  origen text,                                 -- online | pos | prestashop | manual
  pedido_folio text,                           -- folio del pedido/ticket facturado
  rfc text not null,
  nombre text not null,
  email text,
  total numeric(12,2) not null,
  entorno text not null default 'sandbox',     -- sandbox | production
  estado text not null default 'activa',       -- activa | cancelada | pendiente_cancelacion
  motivo_cancelacion text,
  fecha timestamptz not null default now(),
  creado_por text
);
alter table facturas enable row level security;
create index if not exists facturas_pedido_idx on facturas (pedido_folio);
create index if not exists facturas_fecha_idx on facturas (fecha desc);
