// Prueba 03 - Timeout y recuperación.
// 1) Intento inicial con demora simulada de 5 s (cabecera X-Simular-Demora) y cliente que
//    espera solo 2 s: el envío se registra, pero el cliente no recibe la respuesta.
// 2) Reintento con la MISMA Idempotency-Key y SIN demora: debe atenderlo otra réplica y
//    devolver el mismo envío, sin crear uno nuevo.
import { crearBitacora, solicitar, esperar, nuevaClave, sqlTabla, sqlFilas, lit, veredicto, leerJsonl } from './lib/comun.mjs';

const DEMORA_SERVIDOR_MS = 5000;
const TIMEOUT_CLIENTE_MS = 2000;
const cuerpo = { destinatario: 'Ana Torres', direccion: 'Av. Los Olivos 123, Lima' };
const clave = nuevaClave();

const b = crearBitacora('03-timeout-reintento');
b.log('\n# Prueba 03 - Timeout del cliente y reintento');
b.log(`Idempotency-Key de la operación: ${clave}\n`);

// --- Intento inicial --------------------------------------------------------
b.log(`## Intento 1: X-Simular-Demora=${DEMORA_SERVIDOR_MS} ms, el cliente espera ${TIMEOUT_CLIENTE_MS} ms`);
const intento1 = await solicitar(b, {
  etiqueta: 'intento-1-con-demora', metodo: 'POST', ruta: '/envios', cuerpo, clave,
  demoraMs: DEMORA_SERVIDOR_MS, timeoutMs: TIMEOUT_CLIENTE_MS,
});
b.log(intento1);

// Se deja terminar al servidor para que también registre que la respuesta no fue entregada.
await esperar(DEMORA_SERVIDOR_MS - TIMEOUT_CLIENTE_MS + 1500);

const [envio] = await sqlFilas(`SELECT id, instancia_creadora, to_char(creado_en, 'YYYY-MM-DD HH24:MI:SS.US') AS creado_en
                                FROM envios WHERE idempotency_key = ${lit(clave)}`);
b.log('\n## Envío en la base después del timeout del cliente:', envio ?? 'NO EXISTE');
b.log('\n## Eventos registrados por el servidor para el intento 1:');
b.log(await sqlTabla(`
  SELECT to_char(ocurrido_en, 'HH24:MI:SS.US') AS hora, instancia, evento, envio_id, http_status, duracion_ms, detalle
  FROM eventos_intento WHERE idempotency_key = ${lit(clave)} ORDER BY ocurrido_en;`));

b.log(`\nEl cliente dejó de esperar a las ${intento1.fin_cliente}; el envío ${envio?.id} se creó a las ${envio?.creado_en} en ${envio?.instancia_creadora}.`);

// --- Reintento -------------------------------------------------------------
// Round-robin: el siguiente POST va a otra réplica. Si coincidiera con la que creó el envío,
// se repite (cada reintento es seguro por la idempotencia) hasta caer en otra.
b.log('\n## Reintento: misma Idempotency-Key, sin demora');
let reintento;
for (let n = 1; n <= 3; n++) {
  reintento = await solicitar(b, { etiqueta: `reintento-${n}`, metodo: 'POST', ruta: '/envios', cuerpo, clave });
  b.log(reintento);
  if (reintento.x_instance_id && reintento.x_instance_id !== envio?.instancia_creadora) break;
  await esperar(700);
}

const [{ total }] = await sqlFilas(`SELECT COUNT(*)::int AS total FROM envios WHERE idempotency_key = ${lit(clave)}`);
b.log('\n## Intentos de esta operación (vista v_intentos):');
b.log(await sqlTabla(`
  SELECT to_char(recibido_en, 'HH24:MI:SS.US') AS recibido, instancia, resultado_servidor, envio_id, http_status, respuesta_cliente,
         to_char(registrado_en, 'HH24:MI:SS.US') AS registrado, to_char(cliente_desconectado_en, 'HH24:MI:SS.US') AS cliente_desconecto
  FROM v_intentos WHERE idempotency_key = ${lit(clave)} ORDER BY recibido_en;`));
b.log(`\nEnvíos con esta clave: ${total}`);

// Vista del proxy: 499 = el cliente cerró la conexión antes de la respuesta.
b.log('\n## Registro de Nginx para esta operación (logs/nginx/acceso.jsonl):');
const lineasNginx = leerJsonl('acceso.jsonl').filter((l) => l.idempotency_key === clave);
for (const l of lineasNginx) {
  b.log(`  ${l.ts}  ${l.metodo} ${l.ruta}  HTTP ${l.status}  upstream=${l.upstream}  tiempo=${l.tiempo_s}s  request_id=${l.request_id}`);
}

veredicto(b, intento1.resultado_cliente === 'TIMEOUT_CLIENTE', 'el intento 1 terminó por timeout del cliente (no por un código HTTP de error)');
veredicto(b, Boolean(envio), 'el envío quedó registrado aunque el cliente no recibió respuesta');
veredicto(b, reintento.http_status === 200 && reintento.idempotent_replayed && reintento.envio_id === envio?.id,
  `el reintento devolvió el mismo envío (id ${reintento.envio_id}) con Idempotent-Replayed: true`);
veredicto(b, reintento.x_instance_id !== envio?.instancia_creadora,
  `el reintento lo atendió otra réplica (${reintento.x_instance_id} ≠ ${envio?.instancia_creadora})`);
veredicto(b, total === 1, 'existe un solo envío para la operación');
veredicto(b, lineasNginx.some((l) => l.status === '499'), 'Nginx registró el cierre del cliente (HTTP 499) en el intento inicial');
