// Prueba 02 - Continuidad: mientras el cliente consulta /health sin parar,
// se detiene app2, se verifica que app1 y app3 siguen atendiendo, y luego se
// restablece app2 y se verifica que vuelve a recibir solicitudes.
import { crearBitacora, solicitar, esperar, compose, contar, veredicto, horaLima, leerArchivo } from './lib/comun.mjs';

const INTERVALO_MS = 400;
const b = crearBitacora('02-continuidad');
b.log('\n# Prueba 02 - Continuidad del servicio al detener y restablecer app2\n');
// Lo que Nginx registre desde aquí en su error.log corresponde a esta prueba.
const largoErrorLogInicial = leerArchivo('error.log').length;

let fase = 'ANTES';
const resultados = [];
let activo = true;

// Cliente: consulta /health continuamente y anota en qué fase estaba.
const cliente = (async () => {
  let n = 0;
  while (activo) {
    n++;
    const r = await solicitar(b, { etiqueta: `health-${n}`, ruta: '/health', timeoutMs: 3000 });
    r.fase = fase;
    resultados.push(r);
    const marca = r.http_status === 200 ? '' : '   <-- ERROR';
    b.log(`[${fase.padEnd(17)}] ${r.inicio_cliente}  ${r.resultado_cliente}  HTTP ${r.http_status ?? '---'}  ${r.x_instance_id ?? r.error ?? ''}${marca}`);
    await esperar(INTERVALO_MS);
  }
})();

await esperar(4000);

b.log(`\n>>> ${horaLima()}  docker compose stop app2`);
fase = 'DETENIENDO_APP2';
b.log(await compose('stop', 'app2'));
fase = 'APP2_DETENIDA';
b.log(`>>> ${horaLima()}  app2 detenida\n`);

await esperar(8000);

b.log(`\n>>> ${horaLima()}  docker compose start app2`);
fase = 'RESTABLECIENDO';
b.log(await compose('start', 'app2'));
b.log(`>>> ${horaLima()}  app2 iniciada; esperando que vuelva a recibir tráfico\n`);

await esperar(12000);
fase = 'FIN';
activo = false;
await cliente;

const resumen = {};
for (const f of ['ANTES', 'DETENIENDO_APP2', 'APP2_DETENIDA', 'RESTABLECIENDO']) {
  const deFase = resultados.filter((r) => r.fase === f);
  resumen[f] = {
    solicitudes: deFase.length,
    exitosas: deFase.filter((r) => r.http_status === 200).length,
    errores: deFase.filter((r) => r.http_status !== 200).length,
    latencia_max_ms: deFase.length ? Math.max(...deFase.map((r) => r.duracion_ms)) : null,
    por_instancia: contar(deFase.filter((r) => r.http_status === 200), 'x_instance_id'),
  };
}
b.log('\nResumen por fase:', resumen);

const errores = resultados.filter((r) => r.http_status !== 200);
b.log(`\nErrores durante la transición: ${errores.length}`);
for (const e of errores) b.log(` - [${e.fase}] ${e.inicio_cliente} ${e.resultado_cliente} HTTP ${e.http_status ?? '---'} ${e.error ?? ''}`);

// Errores que Nginx resolvió reintentando en otra réplica (el cliente no los ve como error,
// pero sí como mayor latencia).
const erroresNginx = leerArchivo('error.log').slice(largoErrorLogInicial)
  .split('\n').filter((l) => l.includes('upstream'));
b.log(`\nErrores de Nginx hacia las réplicas durante la prueba (logs/nginx/error.log): ${erroresNginx.length}`);
for (const l of erroresNginx) b.log(` - ${l}`);
const lentas = resultados.filter((r) => r.duracion_ms > 1000);
if (lentas.length) {
  b.log('\nSolicitudes con latencia > 1 s (Nginx esperó a app2 y reintentó en otra réplica):');
  for (const r of lentas) b.log(` - [${r.fase}] ${r.inicio_cliente} ${r.duracion_ms} ms -> HTTP ${r.http_status} ${r.x_instance_id}`);
}

const detenida = resumen.APP2_DETENIDA.por_instancia;
const restablecida = resumen.RESTABLECIENDO.por_instancia;
veredicto(b, !detenida.app2 && detenida.app1 > 0 && detenida.app3 > 0, 'con app2 detenida atendieron app1 y app3');
veredicto(b, (restablecida.app2 || 0) > 0, 'app2 volvió a recibir solicitudes tras restablecerla');
