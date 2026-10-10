const express = require('express');
const { PORT, INSTANCE_ID, PERMITIR_SIMULACION } = require('./src/config');
const { pool } = require('./src/db');
const { esperarPendientes } = require('./src/tracking');
const seguimiento = require('./src/middlewares/seguimiento');
const { rutaNoEncontrada, manejadorErrores } = require('./src/middlewares/errores');
const healthRouter = require('./src/rutas/health');
const enviosRouter = require('./src/rutas/envios');

const app = express();
app.disable('x-powered-by');
// Nginx es el único proxy delante de la app: req.ip toma la IP real del cliente.
app.set('trust proxy', true);

app.use(seguimiento);
app.use(express.json({ limit: '10kb' }));
app.use(healthRouter);
app.use(enviosRouter);
app.use(rutaNoEncontrada);
app.use(manejadorErrores);

const server = app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] Escuchando en el puerto ${PORT} (simulación de demora: ${PERMITIR_SIMULACION ? 'habilitada' : 'deshabilitada'})`);
});

// docker stop envía SIGTERM: se dejan de aceptar conexiones, se termina lo que está en curso
// (incluido el registro de eventos) y se cierra el pool antes de salir.
let apagando = false;
function apagar(senal) {
  if (apagando) return;
  apagando = true;
  console.log(`[${INSTANCE_ID}] ${senal} recibido, cerrando...`);
  setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await esperarPendientes();
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
