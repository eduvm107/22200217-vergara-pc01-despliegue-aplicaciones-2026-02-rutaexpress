const os = require('node:os');

// Las credenciales llegan solo por variables de entorno (nunca dentro de la imagen ni del repo).
const REQUERIDAS = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const faltantes = REQUERIDAS.filter((nombre) => !process.env[nombre]);
if (faltantes.length > 0) {
  console.error(`Faltan variables de entorno obligatorias: ${faltantes.join(', ')}`);
  process.exit(1);
}

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  INSTANCE_ID: process.env.INSTANCE_ID || os.hostname(),
  // Solo para la prueba de timeout: habilita la cabecera X-Simular-Demora.
  PERMITIR_SIMULACION: process.env.PERMITIR_SIMULACION === 'true',
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
};
