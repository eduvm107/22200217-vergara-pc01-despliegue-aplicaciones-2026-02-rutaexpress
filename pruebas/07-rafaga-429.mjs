// Prueba 07 - Límite de solicitudes (HTTP 429).
// Fase 1: ráfaga de POST /envios simultáneos desde la misma IP -> Nginx admite 1 + 4 (burst)
//         de inmediato y rechaza el resto con 429.
// Fase 2: tras esperar, se envía a 1 solicitud por segundo (por debajo de 2 r/s) -> todas admitidas.
import { crearBitacora, solicitar, nuevaClave, esperar, contar, veredicto, horaLima } from './lib/comun.mjs';

const TOTAL_RAFAGA = 20;
const TOTAL_LENTAS = 5;

const b = crearBitacora('07-rafaga-429');
b.log('\n# Prueba 07 - Ráfaga sobre POST /envios (límite 2 r/s por IP, burst 4, nodelay)\n');

const cuerpo = (i) => ({ destinatario: `Cliente prueba ráfaga ${i}`, direccion: `Av. Prueba ${100 + i}, Lima` });

// --- Fase 1: ráfaga -------------------------------------------------------
b.log(`## Fase 1: ${TOTAL_RAFAGA} solicitudes simultáneas (cada una es un envío distinto)`);
const inicioRafaga = performance.now();
b.log(`Inicio: ${horaLima()}`);
const rafaga = await Promise.all(
  Array.from({ length: TOTAL_RAFAGA }, (_, i) =>
    solicitar(b, { etiqueta: `rafaga-${i + 1}`, metodo: 'POST', ruta: '/envios', cuerpo: cuerpo(i + 1), clave: nuevaClave() })),
);
const duracionRafaga = performance.now() - inicioRafaga;
b.log(`Fin:    ${horaLima()}`);

const codigosRafaga = contar(rafaga, 'http_status');
const resumenRafaga = {
  solicitudes: TOTAL_RAFAGA,
  duracion_ms: Number(duracionRafaga.toFixed(1)),
  tasa_aprox_rps: Number((TOTAL_RAFAGA / (duracionRafaga / 1000)).toFixed(1)),
  codigos_http: codigosRafaga,
  admitidas_atendidas_por: contar(rafaga.filter((r) => r.http_status === 201), 'x_instance_id'),
  duracion_max_admitidas_ms: Math.max(...rafaga.filter((r) => r.http_status === 201).map((r) => r.duracion_ms)),
};
b.log('Resumen de la ráfaga:', resumenRafaga);
for (const r of rafaga) {
  b.log(`  ${r.etiqueta.padEnd(9)} HTTP ${r.http_status}  ${String(r.duracion_ms).padStart(6)} ms  réplica=${r.x_instance_id ?? '(nginx)'}  request_id=${r.x_request_id}`);
}

// --- Fase 2: frecuencia reducida -----------------------------------------
await esperar(3000);
b.log(`\n## Fase 2: ${TOTAL_LENTAS} solicitudes a 1 por segundo`);
const lentas = [];
for (let i = 1; i <= TOTAL_LENTAS; i++) {
  const r = await solicitar(b, { etiqueta: `lenta-${i}`, metodo: 'POST', ruta: '/envios', cuerpo: cuerpo(100 + i), clave: nuevaClave() });
  lentas.push(r);
  b.log(`  ${r.inicio_cliente}  HTTP ${r.http_status}  réplica=${r.x_instance_id}`);
  await esperar(1000);
}
b.log('Códigos HTTP fase 2:', contar(lentas, 'http_status'));

const rechazadas = codigosRafaga['429'] || 0;
const admitidas = codigosRafaga['201'] || 0;
veredicto(b, rechazadas > 0, `la ráfaga produjo ${rechazadas} rechazos HTTP 429`);
veredicto(b, admitidas >= 5 && admitidas <= 6, `se admitieron ${admitidas} (1 + ráfaga de 4) sin espera`);
veredicto(b, rafaga.filter((r) => r.http_status === 429).every((r) => r.x_instance_id === null),
  'los 429 los generó Nginx (no llevan X-Instance-ID: no llegaron a la aplicación)');
veredicto(b, lentas.every((r) => r.http_status === 201), 'al reducir la frecuencia se admitieron todas las solicitudes');
