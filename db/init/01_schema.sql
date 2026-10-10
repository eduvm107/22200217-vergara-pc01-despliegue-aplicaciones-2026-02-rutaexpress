-- RutaExpress - estructura de datos
-- Se ejecuta automáticamente la primera vez que se crea el volumen de PostgreSQL
-- (docker-entrypoint-initdb.d). Es idempotente: también puede correrse a mano.

-- ---------------------------------------------------------------------------
-- envios: un registro por envío solicitado.
-- idempotency_key es la clave que genera el cliente por cada operación de negocio.
-- La restricción UNIQUE garantiza, a nivel de base y sin importar la réplica,
-- que un reintento no pueda crear un segundo envío.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envios (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key     VARCHAR(128)   NOT NULL,
    destinatario        VARCHAR(200)   NOT NULL,
    direccion           VARCHAR(300)   NOT NULL,
    request_hash        CHAR(64)       NOT NULL,
    instancia_creadora  VARCHAR(50)    NOT NULL,
    creado_en           TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_envios_idempotency_key UNIQUE (idempotency_key)
);

COMMENT ON COLUMN envios.idempotency_key    IS 'Clave enviada por el cliente en la cabecera Idempotency-Key';
COMMENT ON COLUMN envios.request_hash       IS 'SHA-256 de [destinatario, direccion]: detecta reutilización de la clave con otros datos';
COMMENT ON COLUMN envios.instancia_creadora IS 'Réplica que creó el envío (app1, app2 o app3)';

-- ---------------------------------------------------------------------------
-- eventos_intento: traza de cada solicitud que llega al backend.
-- Una fila por evento (no se actualizan): RECIBIDO -> resultado -> respuesta.
-- Los rechazos HTTP 429 ocurren en Nginx y quedan en su propio log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eventos_intento (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id       VARCHAR(64)    NOT NULL,
    evento           VARCHAR(30)    NOT NULL,
    ocurrido_en      TIMESTAMPTZ(6) NOT NULL,
    registrado_en    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    metodo           VARCHAR(10)    NOT NULL,
    ruta             VARCHAR(200)   NOT NULL,
    instancia        VARCHAR(50)    NOT NULL,
    ip_cliente       VARCHAR(64),
    idempotency_key  VARCHAR(128),
    envio_id         BIGINT REFERENCES envios (id),
    http_status      SMALLINT,
    duracion_ms      NUMERIC(10, 3),
    detalle          VARCHAR(300),
    CONSTRAINT ck_eventos_intento_evento CHECK (evento IN (
        'RECIBIDO',               -- la solicitud llegó a la réplica
        'REGISTRADO',             -- se creó un envío nuevo (confirmado en la base)
        'REPETIDO',               -- reintento: se devolvió el envío existente
        'ATENDIDO',               -- solicitud atendida sin crear envío (ej. /health)
        'RECHAZADO',              -- validación o regla de negocio (4xx)
        'FALLIDO',                -- error inesperado (5xx)
        'RESPONDIDO',             -- la respuesta se entregó completa
        'CLIENTE_DESCONECTADO',   -- el cliente cerró la conexión antes de la respuesta
        'RESPUESTA_NO_ENTREGADA'  -- el servidor terminó, pero ya no había quién recibiera
    ))
);

CREATE INDEX IF NOT EXISTS ix_eventos_intento_request_id      ON eventos_intento (request_id);
CREATE INDEX IF NOT EXISTS ix_eventos_intento_idempotency_key ON eventos_intento (idempotency_key);
CREATE INDEX IF NOT EXISTS ix_eventos_intento_envio_id        ON eventos_intento (envio_id);
CREATE INDEX IF NOT EXISTS ix_eventos_intento_ocurrido_en     ON eventos_intento (ocurrido_en);

-- ---------------------------------------------------------------------------
-- v_intentos: una fila por solicitud (agrupa sus eventos).
-- resultado_servidor = lo que hizo el backend; respuesta_cliente = si llegó o no.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_intentos AS
SELECT
    request_id,
    MIN(ocurrido_en)                                   AS recibido_en,
    MAX(metodo)                                        AS metodo,
    MAX(ruta)                                          AS ruta,
    MAX(instancia)                                     AS instancia,
    MAX(ip_cliente)                                    AS ip_cliente,
    MAX(idempotency_key)                               AS idempotency_key,
    MAX(evento) FILTER (WHERE evento IN ('REGISTRADO', 'REPETIDO', 'ATENDIDO', 'RECHAZADO', 'FALLIDO'))
                                                       AS resultado_servidor,
    MAX(detalle) FILTER (WHERE evento IN ('RECHAZADO', 'FALLIDO'))
                                                       AS motivo,
    MAX(envio_id)                                      AS envio_id,
    MAX(http_status)                                   AS http_status,
    CASE
        WHEN BOOL_OR(evento = 'RESPONDIDO') THEN 'ENTREGADA'
        WHEN BOOL_OR(evento IN ('CLIENTE_DESCONECTADO', 'RESPUESTA_NO_ENTREGADA')) THEN 'NO_ENTREGADA'
        ELSE 'EN_CURSO'
    END                                                AS respuesta_cliente,
    MAX(ocurrido_en) FILTER (WHERE evento = 'REGISTRADO')
                                                       AS registrado_en,
    MAX(ocurrido_en) FILTER (WHERE evento = 'CLIENTE_DESCONECTADO')
                                                       AS cliente_desconectado_en,
    MAX(duracion_ms)                                   AS duracion_ms
FROM eventos_intento
GROUP BY request_id;

-- ---------------------------------------------------------------------------
-- v_intentos_por_envio: todos los intentos relacionados con cada envío.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_intentos_por_envio AS
SELECT
    e.id                  AS envio_id,
    e.idempotency_key,
    e.destinatario,
    e.creado_en,
    e.instancia_creadora,
    COUNT(i.request_id)   AS total_intentos,
    STRING_AGG(
        i.instancia || ':' || COALESCE(i.resultado_servidor, '?') || ':' ||
        COALESCE(i.http_status::TEXT, '-') || ':' || i.respuesta_cliente,
        ' | ' ORDER BY i.recibido_en
    )                     AS secuencia_intentos
FROM envios e
LEFT JOIN v_intentos i ON i.idempotency_key = e.idempotency_key AND i.ruta = '/envios'
GROUP BY e.id, e.idempotency_key, e.destinatario, e.creado_en, e.instancia_creadora;
