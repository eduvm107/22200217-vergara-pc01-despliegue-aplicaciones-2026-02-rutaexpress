-- Consultas de evidencia (DBeaver: localhost:15432, base/usuario/clave del archivo .env)

-- 1. Envíos registrados
SELECT id, idempotency_key, destinatario, direccion, instancia_creadora, creado_en
FROM envios
ORDER BY id;

-- 2. Cada solicitud que llegó al backend (una fila por intento)
SELECT recibido_en, metodo, ruta, instancia, idempotency_key, resultado_servidor, motivo,
       envio_id, http_status, respuesta_cliente, duracion_ms, request_id
FROM v_intentos
ORDER BY recibido_en;

-- 3. Intentos agrupados por envío (relaciona reintentos de una misma operación)
SELECT envio_id, destinatario, instancia_creadora, total_intentos, secuencia_intentos
FROM v_intentos_por_envio
ORDER BY envio_id;

-- 4. Operaciones con más de un intento (reintentos y concurrencia) y que aun así tienen un solo envío
SELECT i.idempotency_key,
       COUNT(*)                                   AS intentos,
       COUNT(DISTINCT i.instancia)                AS replicas_distintas,
       STRING_AGG(DISTINCT i.instancia, ', ')     AS replicas,
       (SELECT COUNT(*) FROM envios e WHERE e.idempotency_key = i.idempotency_key) AS envios_creados
FROM v_intentos i
WHERE i.ruta = '/envios' AND i.idempotency_key IS NOT NULL
GROUP BY i.idempotency_key
HAVING COUNT(*) > 1
ORDER BY MIN(i.recibido_en);

-- 5. Línea de tiempo detallada de una operación (reemplace la clave)
SELECT ocurrido_en, instancia, evento, envio_id, http_status, duracion_ms, detalle
FROM eventos_intento
WHERE idempotency_key = 'REEMPLAZAR-POR-LA-CLAVE'
ORDER BY ocurrido_en;

-- 6. Intentos cuya respuesta no llegó al cliente (timeouts)
SELECT recibido_en, instancia, idempotency_key, resultado_servidor, envio_id, http_status,
       registrado_en, cliente_desconectado_en
FROM v_intentos
WHERE respuesta_cliente = 'NO_ENTREGADA'
ORDER BY recibido_en;

-- 7. Resumen de resultados por réplica
SELECT instancia, ruta, resultado_servidor, http_status, COUNT(*) AS total
FROM v_intentos
GROUP BY instancia, ruta, resultado_servidor, http_status
ORDER BY instancia, ruta, resultado_servidor;

-- 8. Comprobación global: ninguna clave tiene más de un envío (debe devolver 0 filas)
SELECT idempotency_key, COUNT(*) FROM envios GROUP BY idempotency_key HAVING COUNT(*) > 1;
