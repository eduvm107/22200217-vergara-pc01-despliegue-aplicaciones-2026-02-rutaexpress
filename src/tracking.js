const { pool } = require('./db');
const { INSTANCE_ID } = require('./config');

// Registro de intentos como eventos: cada etapa de una solicitud agrega una fila nueva,
// nunca se sobrescribe la anterior. Se escribe en segundo plano para no retrasar la
// respuesta al cliente; si falla, se reintenta una vez y como último recurso queda
// en la salida estándar del contenedor (docker compose logs).

const INSERTAR_EVENTO = `
  INSERT INTO eventos_intento
    (request_id, evento, ocurrido_en, metodo, ruta, instancia, ip_cliente,
     idempotency_key, envio_id, http_status, duracion_ms, detalle)
  VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

const ESPERA_REINTENTO_MS = 500;
const pendientes = new Set();

// Segundos epoch con fracción de microsegundos: permite ordenar eventos muy cercanos.
function marcaDeTiempo() {
  return (performance.timeOrigin + performance.now()) / 1000;
}

function insertar(evento) {
  return pool.query(INSERTAR_EVENTO, [
    evento.requestId,
    evento.evento,
    evento.ocurridoEn,
    evento.metodo,
    evento.ruta,
    evento.instancia,
    evento.ip ?? null,
    evento.idempotencyKey ?? null,
    evento.envioId ?? null,
    evento.httpStatus ?? null,
    evento.duracionMs ?? null,
    evento.detalle ?? null,
  ]);
}

function registrarEvento(datos) {
  const evento = { ...datos, instancia: INSTANCE_ID, ocurridoEn: marcaDeTiempo() };

  const tarea = insertar(evento)
    .catch(() => new Promise((r) => setTimeout(r, ESPERA_REINTENTO_MS)).then(() => insertar(evento)))
    .catch((err) => {
      console.error(JSON.stringify({ tipo: 'EVENTO_NO_PERSISTIDO', error: err.message, evento }));
    })
    .finally(() => pendientes.delete(tarea));

  pendientes.add(tarea);
}

// Al apagar la réplica se espera a que terminen las escrituras en curso.
function esperarPendientes() {
  return Promise.allSettled([...pendientes]);
}

module.exports = { registrarEvento, esperarPendientes };
