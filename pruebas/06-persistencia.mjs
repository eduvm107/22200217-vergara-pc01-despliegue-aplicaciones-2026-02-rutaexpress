// Prueba 06 - Persistencia: se registran 3 envíos, se recrean TODOS los contenedores
// (docker compose down + up, sin borrar volúmenes) y se verifica que siguen los mismos
// ids y datos. Luego se reintenta una operación ya completada: no debe duplicarse.
import { crearBitacora, solicitar, nuevaClave, sqlTabla, sqlFilas, compose, esperar, lit, horaLima, veredicto } from './lib/comun.mjs';

const b = crearBitacora('06-persistencia');
b.log('\n# Prueba 06 - Persistencia al recrear contenedores\n');

const operaciones = [
  { clave: nuevaClave(), cuerpo: { destinatario: 'María Quispe', direccion: 'Av. Arequipa 1520, Lince' } },
  { clave: nuevaClave(), cuerpo: { destinatario: 'Jorge Salazar', direccion: 'Av. Brasil 2840, Pueblo Libre' } },
  { clave: nuevaClave(), cuerpo: { destinatario: 'Rosa Huamán', direccion: 'Jr. de la Unión 615, Cercado de Lima' } },
];

for (const [i, op] of operaciones.entries()) {
  const r = await solicitar(b, { etiqueta: `envio-${i + 1}`, metodo: 'POST', ruta: '/envios', cuerpo: op.cuerpo, clave: op.clave });
  b.log(`Envío ${i + 1}: HTTP ${r.http_status} id=${r.envio_id} réplica=${r.x_instance_id} clave=${op.clave}`);
  await esperar(700);
}

const filtro = `idempotency_key IN (${operaciones.map((o) => lit(o.clave)).join(', ')})`;
const consulta = `SELECT id, idempotency_key, destinatario, direccion, instancia_creadora, creado_en FROM envios WHERE ${filtro} ORDER BY id`;

const antes = await sqlFilas(consulta);
b.log('\n## Antes de recrear:');
b.log(await sqlTabla(consulta + ';'));
const idsContenedoresAntes = await compose('ps', '-q');

b.log(`\n>>> ${horaLima()}  docker compose down   (sin -v: el volumen db_data se conserva)`);
b.log(await compose('down'));
b.log(`>>> ${horaLima()}  docker compose up -d --wait`);
b.log(await compose('up', '-d', '--wait'));
const idsContenedoresDespues = await compose('ps', '-q');

b.log('\nIDs de contenedores antes:\n' + idsContenedoresAntes);
b.log('IDs de contenedores después:\n' + idsContenedoresDespues);

const despues = await sqlFilas(consulta);
b.log('\n## Después de recrear:');
b.log(await sqlTabla(consulta + ';'));

b.log('\n## Reintento de la operación 1 después de la recreación:');
const reintento = await solicitar(b, { etiqueta: 'reintento-post-recreacion', metodo: 'POST', ruta: '/envios', cuerpo: operaciones[0].cuerpo, clave: operaciones[0].clave });
b.log(reintento);
const [{ total }] = await sqlFilas(`SELECT COUNT(*)::int AS total FROM envios WHERE idempotency_key = ${lit(operaciones[0].clave)}`);
b.log(`Envíos con la clave de la operación 1: ${total}`);

const sinCambios = JSON.stringify(antes) === JSON.stringify(despues);
const recreados = idsContenedoresAntes.split('\n').every((id) => !idsContenedoresDespues.includes(id));
veredicto(b, antes.length === 3, 'se registraron 3 envíos distintos');
veredicto(b, recreados, 'todos los contenedores son nuevos (IDs distintos)');
veredicto(b, sinCambios, 'después de recrear se conservan los mismos ids y datos');
veredicto(b, reintento.http_status === 200 && reintento.envio_id === antes[0]?.id && total === 1,
  `el reintento devolvió el envío ${reintento.envio_id} existente y no se creó un duplicado`);
