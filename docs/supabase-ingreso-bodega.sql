-- 2026-11-23 (migración ingreso_solo_bodega_asignada): quien tiene sucursal asignada en Personal / Equipo
-- (personal_equipo.bodega_asignada distinta de "Todas") solo puede meter mercancía a esa sucursal.
-- staff_bodega_ingreso(creds) -> 'rumania' | 'puebla' | 'queretaro' | null (sin restricción: admin o "Todas").
-- staff_exigir_bodega(creds, almacen) lanza 'bodega_no_permitida: solo puedes meter mercancía a <sucursal>'.
-- Se llama en rpc_recep_crear, rpc_recep_autorizar, rpc_mov_doc_save (tipo entrada) y rpc_mov_doc_approve (entrada).
-- Traspasos y salidas no cambian. Definiciones completas en Supabase (pg_get_functiondef).

-- 2026-11-25 (migración material_decoracion_no_es_venta): método de pago 'material' en el POS (solo CDMX)
-- para sacar mercancía como material de decoraciones. Descuenta inventario (kardex motivo
-- 'material_decoracion') pero no es venta: fuera de pos_ventas_producto_mes, asistencia_ventas_pos,
-- api/ventas, api/v1/branch-sales y del corte de caja (que solo suma cash/card/transfer).

-- 2026-11-25 (migración pos_pagos_mixtos): ventas mixtas en el POS.
-- pos_tickets.pagos = [{metodo: cash|card|transfer, monto}] y metodo = 'mixto' (si solo hay una parte, se
-- guarda como ese método). rpc_pos_ticket_insert(..., p_pagos jsonb) valida que las partes sumen el total
-- ('pago_mixto_no_cuadra'). pos_monto_metodo(ticket, metodo) da lo que aporta un ticket a cada método;
-- rpc_caja_resumen y rpc_resumen_dia (efectivo desde la apertura) ya suman por partes.
