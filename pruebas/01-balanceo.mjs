// Prueba 01 - Balanceo: solicitudes a /health a una frecuencia inferior al límite
// deben repartirse entre app1, app2 y app3.
import { crearBitacora, solicitar, esperar, contar, veredicto } from './lib/comun.mjs';

const TOTAL = 12;
const INTERVALO_MS = 600; // ~1,7 solicitudes por segundo (< 2 r/s)

const b = crearBitacora('01-balanceo');
b.log(`\n# Prueba 01 - Balanceo: ${TOTAL} GET /health, una cada ${INTERVALO_MS} ms\n`);

const resultados = [];
for (let i = 1; i <= TOTAL; i++) {
  const r = await solicitar(b, { etiqueta: `health-${i}`, ruta: '/health' });
  resultados.push(r);
  b.log(`${String(i).padStart(2)}. ${r.inicio_cliente}  HTTP ${r.http_status ?? '---'}  X-Instance-ID=${r.x_instance_id}  body.instance=${r.instance}`);
  await esperar(INTERVALO_MS);
}

const exitosas = resultados.filter((r) => r.http_status === 200);
const porInstancia = contar(exitosas, 'x_instance_id');
b.log('\nRespuestas exitosas por instancia:', porInstancia);

veredicto(b, exitosas.length >= 9, `${exitosas.length} solicitudes exitosas (mínimo 9)`);
veredicto(b, ['app1', 'app2', 'app3'].every((i) => porInstancia[i] > 0), 'respondieron las tres instancias');
