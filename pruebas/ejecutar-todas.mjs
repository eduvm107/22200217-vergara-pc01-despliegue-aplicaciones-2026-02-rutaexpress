// Ejecuta las pruebas en orden (la 08 necesita los rechazos que genera la 07).
// Uso: node pruebas/ejecutar-todas.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { RAIZ } from './lib/comun.mjs';

const PRUEBAS = [
  '01-balanceo.mjs',
  '02-continuidad.mjs',
  '03-timeout-reintento.mjs',
  '04-concurrencia.mjs',
  '05-intencionales.mjs',
  '06-persistencia.mjs',
  '07-rafaga-429.mjs',
  '08-registro-429.mjs',
];

const resumen = [];
for (const prueba of PRUEBAS) {
  console.log(`\n==================== ${prueba} ====================`);
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'pruebas', prueba)], { stdio: 'inherit', cwd: RAIZ });
  resumen.push({ prueba, resultado: r.status === 0 ? 'CUMPLE' : 'REVISAR' });
  // Pausa para que la cuota de 2 r/s de Nginx se recupere entre pruebas.
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.log('\n==================== Resumen ====================');
console.table(resumen);
process.exitCode = resumen.every((r) => r.resultado === 'CUMPLE') ? 0 : 1;
