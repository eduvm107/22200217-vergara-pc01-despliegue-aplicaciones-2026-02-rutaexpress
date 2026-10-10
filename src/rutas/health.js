const express = require('express');
const { pool } = require('../db');
const { INSTANCE_ID } = require('../config');

const router = express.Router();

// Consulta real a PostgreSQL: si la base no responde, la réplica informa 503.
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    req.seguimiento.registrar('ATENDIDO');
    res.json({ status: 'ok', database: 'connected', instance: INSTANCE_ID });
  } catch (err) {
    req.seguimiento.registrar('FALLIDO', { detalle: String(err.message).slice(0, 300) });
    res.status(503).json({ status: 'error', database: 'disconnected', instance: INSTANCE_ID });
  }
});

module.exports = router;
