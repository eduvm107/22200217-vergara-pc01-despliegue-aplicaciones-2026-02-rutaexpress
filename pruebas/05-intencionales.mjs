// Prueba 05 - Envíos nuevos intencionales con el mismo destinatario y dirección.
// Cada operación nueva usa su propia Idempotency-Key, así que ambas se registran.
import { crearBitacora, solicitar, nuevaClave, sqlTabla, esperar, lit, veredicto } from './lib/comun.mjs';

const cuerpo = { destinatario: 'Lucía Mendoza', direccion: 'Calle Las Begonias 789, San Isidro' };
const b = crearBitacora('05-intencionales');
b.log('\n# Prueba 05 - Dos envíos nuevos e intencionales con los mismos datos\n');

const clave1 = nuevaClave();
const clave2 = nuevaClave();
const primero = await solicitar(b, { etiqueta: 'intencional-1', metodo: 'POST', ruta: '/envios', cuerpo, clave: clave1 });
b.log(primero);
await esperar(700);
const segundo = await solicitar(b, { etiqueta: 'intencional-2', metodo: 'POST', ruta: '/envios', cuerpo, clave: clave2 });
b.log(segundo);

b.log('\n## Envíos registrados con esos datos:');
b.log(await sqlTabla(`
  SELECT id, idempotency_key, destinatario, direccion, instancia_creadora, creado_en
  FROM envios WHERE idempotency_key IN (${lit(clave1)}, ${lit(clave2)}) ORDER BY id;`));

veredicto(b, primero.http_status === 201 && segundo.http_status === 201, 'ambas solicitudes respondieron 201 Created');
veredicto(b, primero.envio_id !== segundo.envio_id, `se crearon dos envíos distintos (ids ${primero.envio_id} y ${segundo.envio_id})`);
