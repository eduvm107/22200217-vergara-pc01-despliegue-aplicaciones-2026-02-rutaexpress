// Prueba 04 - Concurrencia: dos intentos simultáneos de la MISMA operación (misma
// Idempotency-Key) atendidos por réplicas distintas deben producir un solo envío.
import { crearBitacora, solicitar, nuevaClave, sqlTabla, sqlFilas, lit, veredicto, esperar } from './lib/comun.mjs';

const cuerpo = { destinatario: 'Carlos Ramos', direccion: 'Jr. Huallaga 450, Cercado de Lima' };
const b = crearBitacora('04-concurrencia');
b.log('\n# Prueba 04 - Dos intentos simultáneos de la misma operación\n');

let clave;
let a;
let c;
// Con round-robin dos solicitudes simultáneas caen en réplicas distintas; si no ocurriera,
// se repite con una operación nueva.
for (let n = 1; n <= 3; n++) {
  clave = nuevaClave();
  b.log(`Idempotency-Key: ${clave}`);
  [a, c] = await Promise.all([
    solicitar(b, { etiqueta: 'simultaneo-A', metodo: 'POST', ruta: '/envios', cuerpo, clave }),
    solicitar(b, { etiqueta: 'simultaneo-B', metodo: 'POST', ruta: '/envios', cuerpo, clave }),
  ]);
  b.log(a, c);
  if (a.x_instance_id && c.x_instance_id && a.x_instance_id !== c.x_instance_id) break;
  b.log('Ambas cayeron en la misma réplica; se repite con otra operación.\n');
  await esperar(1500);
}

const [{ total }] = await sqlFilas(`SELECT COUNT(*)::int AS total FROM envios WHERE idempotency_key = ${lit(clave)}`);
b.log('\n## Intentos registrados por el servidor:');
b.log(await sqlTabla(`
  SELECT to_char(recibido_en, 'HH24:MI:SS.US') AS recibido, instancia, resultado_servidor, envio_id, http_status, respuesta_cliente
  FROM v_intentos WHERE idempotency_key = ${lit(clave)} ORDER BY recibido_en;`));
b.log('\n## Envíos con esa clave:');
b.log(await sqlTabla(`SELECT id, idempotency_key, destinatario, instancia_creadora, creado_en FROM envios WHERE idempotency_key = ${lit(clave)};`));

const codigos = [a.http_status, c.http_status].sort();
veredicto(b, a.x_instance_id !== c.x_instance_id, `atendidas por réplicas distintas (${a.x_instance_id} y ${c.x_instance_id})`);
veredicto(b, codigos[0] === 200 && codigos[1] === 201, `una respuesta 201 (creó) y otra 200 (repetido): ${codigos.join(', ')}`);
veredicto(b, a.envio_id === c.envio_id, `ambas devuelven el mismo id de envío (${a.envio_id})`);
veredicto(b, total === 1, 'existe un solo envío');
