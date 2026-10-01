# Notificaciones push (app cerrada)

Antes las notificaciones solo salían con el panel abierto (un revisor cada 45 s
en el navegador). Ahora el servidor manda Web Push cuando entra un pedido y
cuando se acepta un pago.

## 1. Tabla en Supabase (una vez)

```sql
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  dispositivo text,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
-- Sin políticas: solo la llave de servicio (API de Vercel) puede leer/escribir.
```

## 2. Variables en Vercel (una vez)

Generar el par de llaves: `npx web-push generate-vapid-keys`

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (opcional, ej. `mailto:contacto@mifiestashop.com`)

`SUPABASE_SERVICE_ROLE_KEY` ya existe.

## 3. En cada dispositivo

Notificaciones → "Activar notificaciones" (acepta el permiso).
En iPhone/iPad hay que instalar primero la app: Safari → Compartir → "Agregar a
pantalla de inicio", abrirla desde el ícono y ahí activar (iOS 16.4+).
