-- "Como regalo": un producto se puede marcar como regalo a cambio de una reseña (editor de productos).
-- El POS lo ofrece en el carrito (piezas de regalo a $0); la reseña del cliente se adjunta después al ticket
-- (api/pedido-admin.js, acción "resena_regalo"). Aplicado en Supabase el 2026-10-22.
alter table public.producto_privado add column if not exists regalo_resena boolean not null default false;
