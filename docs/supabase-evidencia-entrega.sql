-- Evidencia de envío/entrega de los pedidos de la tienda en línea (pedidos_online).
-- Para pasar un pedido a "Enviado" o "Entregado" api/pedido-admin.js exige UNA de estas:
--   - guía de rastreo (tracking_number; la guía de Skydropx se guarda sola),
--   - baucher de Uber / Lala Move   (evidencia_tipo = 'uber_lala' + evidencia_url),
--   - ticket firmado de recibido + foto de la identificación (evidencia_tipo = 'ticket_firmado' + evidencia_url + evidencia_id_url).
-- Las fotos viven en el bucket público "assets", carpeta entregas/.
alter table public.pedidos_online
  add column if not exists evidencia_tipo text,
  add column if not exists evidencia_url text,
  add column if not exists evidencia_id_url text,
  add column if not exists evidencia_por text,
  add column if not exists evidencia_at timestamptz;
