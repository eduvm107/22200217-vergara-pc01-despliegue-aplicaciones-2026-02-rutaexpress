const { Pool, types } = require('pg');
const { db, INSTANCE_ID } = require('./config');

// BIGINT (OID 20) llega como string por defecto; los ids de envío caben en un Number.
types.setTypeParser(20, (valor) => Number(valor));

// El pool se crea una sola vez al iniciar la réplica y se reutiliza en cada solicitud.
const pool = new Pool({
  ...db,
  max: 10,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
});

// Un error en una conexión inactiva no debe tumbar el proceso.
pool.on('error', (err) => {
  console.error(JSON.stringify({ tipo: 'POOL_ERROR', instancia: INSTANCE_ID, error: err.message }));
});

module.exports = { pool };
