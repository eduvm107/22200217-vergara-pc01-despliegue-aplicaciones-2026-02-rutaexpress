// Prueba 08 - Registro de rechazos 429.
// Nginx es quien genera los 429, así que es quien los registra: logs/nginx/rechazos_429.jsonl
// (montado desde el host). Se consulta, se recrea el contenedor nginx y se vuelve a consultar.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { crearBitacora, compose, horaLima, veredicto, RAIZ, esperar } from './lib/comun.mjs';

const ARCHIVO = path.join(RAIZ, 'logs', 'nginx', 'rechazos_429.jsonl');

function leerRechazos() {
  if (!existsSync(ARCHIVO)) return [];
  return readFileSync(ARCHIVO, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const b = crearBitacora('08-registro-429');
b.log('\n# Prueba 08 - Consulta y persistencia del registro de rechazos 429\n');

const antes = leerRechazos();
b.log(`Archivo: ${path.relative(RAIZ, ARCHIVO)}  ->  ${antes.length} rechazos registrados`);
b.log('Últimos 5 rechazos:');
for (const r of antes.slice(-5)) {
  b.log(`  ${r.ts}  ip=${r.ip_cliente}  ${r.metodo} ${r.ruta}  HTTP ${r.status}  limite=${r.limite}  upstream="${r.upstream}"  request_id=${r.request_id}`);
}

// Consulta de ejemplo: rechazos por IP y por minuto (lo que se usaría para atender un reclamo).
const porIp = {};
const porMinuto = {};
for (const r of antes) {
  porIp[r.ip_cliente] = (porIp[r.ip_cliente] || 0) + 1;
  const minuto = r.ts.slice(0, 16);
  porMinuto[minuto] = (porMinuto[minuto] || 0) + 1;
}
b.log('\nRechazos por IP:', porIp);
b.log('Rechazos por minuto:', porMinuto);

const idAntes = await compose('ps', '-q', 'nginx');
b.log(`\n>>> ${horaLima()}  docker compose up -d --force-recreate nginx`);
b.log(await compose('up', '-d', '--force-recreate', '--wait', 'nginx'));
await esperar(1000);
const idDespues = await compose('ps', '-q', 'nginx');
b.log(`Contenedor nginx antes:   ${idAntes}`);
b.log(`Contenedor nginx después: ${idDespues}`);

const despues = leerRechazos();
b.log(`\nDespués de recrear nginx: ${despues.length} rechazos registrados`);
const conservados = antes.every((r, i) => despues[i]?.request_id === r.request_id);

const camposProhibidos = ['body', 'request_body', 'destinatario', 'direccion', 'password', 'authorization'];
const sinDatosSensibles = despues.every((r) => camposProhibidos.every((c) => !(c in r)));

veredicto(b, antes.length > 0, 'existen rechazos 429 registrados (ejecute antes la prueba 07)');
veredicto(b, antes.every((r) => r.ts && r.ip_cliente && r.metodo && r.ruta && r.status === '429'),
  'cada registro tiene fecha y hora, IP, método, ruta y código HTTP');
veredicto(b, idAntes !== idDespues, 'el contenedor nginx fue recreado');
veredicto(b, conservados, 'los rechazos registrados antes siguen presentes después de recrear nginx');
veredicto(b, sinDatosSensibles, 'el registro no contiene cuerpo, datos personales ni credenciales');
