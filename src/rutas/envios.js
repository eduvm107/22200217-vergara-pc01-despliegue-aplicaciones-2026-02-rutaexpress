const express = require('express');
const { createHash } = require('node:crypto');
const { pool } = require('../db');
const { AppError } = require('../errores');
const { PERMITIR_SIMULACION, INSTANCE_ID } = require('../config');

const router = express.Router();

const PATRON_CLAVE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_DESTINATARIO = 200;
const MAX_DIRECCION = 300;
const MAX_DEMORA_MS = 10000;

// La restricción UNIQUE sobre idempotency_key es quien decide, de forma atómica,
// qué intento crea el envío. Si dos réplicas insertan la misma clave a la vez,
// PostgreSQL hace esperar a la segunda y luego no inserta nada.
const INSERTAR_ENVIO = `
  INSERT INTO envios (idempotency_key, destinatario, direccion, request_hash, instancia_creadora)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id, destinatario, direccion`;

const BUSCAR_POR_CLAVE = `
  SELECT id, destinatario, direccion, request_hash
  FROM envios
  WHERE idempotency_key = $1`;

function validarClave(clave) {
  if (!clave) {
    throw new AppError(400, 'FALTA_IDEMPOTENCY_KEY',
      'Envíe la cabecera Idempotency-Key (un UUID nuevo por cada envío; el mismo en cada reintento)');
  }
  if (!PATRON_CLAVE.test(clave)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALIDA',
      'Idempotency-Key debe tener entre 8 y 128 caracteres: letras, números, guion o guion bajo');
  }
  return clave;
}

function validarTexto(valor, campo, maximo) {
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new AppError(400, 'DATOS_INVALIDOS', `${campo} es obligatorio y debe ser texto`);
  }
  const limpio = valor.trim();
  if (limpio.length > maximo) {
    throw new AppError(400, 'DATOS_INVALIDOS', `${campo} admite como máximo ${maximo} caracteres`);
  }
  return limpio;
}

function validarCuerpo(req) {
  if (!req.is('application/json')) {
    throw new AppError(415, 'TIPO_NO_SOPORTADO', 'Envíe Content-Type: application/json');
  }
  const cuerpo = req.body;
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw new AppError(400, 'DATOS_INVALIDOS', 'El cuerpo debe ser un objeto JSON');
  }
  return {
    destinatario: validarTexto(cuerpo.destinatario, 'destinatario', MAX_DESTINATARIO),
    direccion: validarTexto(cuerpo.direccion, 'direccion', MAX_DIRECCION),
  };
}

// Huella del contenido: detecta si alguien reutiliza una clave con datos distintos.
function calcularHash(destinatario, direccion) {
  return createHash('sha256').update(JSON.stringify([destinatario, direccion])).digest('hex');
}

// Solo para la prueba de timeout. Se ejecuta DESPUÉS de confirmar el registro.
async function simularDemoraSiCorresponde(req) {
  if (!PERMITIR_SIMULACION) return;
  const demoraMs = Number(req.get('X-Simular-Demora'));
  if (!Number.isInteger(demoraMs) || demoraMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(demoraMs, MAX_DEMORA_MS)));
}

router.post('/envios', async (req, res, next) => {
  const seg = req.seguimiento;
  // La respuesta tiene su forma fija desde el inicio; solo se completan los valores.
  const respuesta = { httpStatus: null, repetido: false, cuerpo: null };

  try {
    const clave = validarClave(req.get('Idempotency-Key'));
    const { destinatario, direccion } = validarCuerpo(req);
    const hash = calcularHash(destinatario, direccion);

    // Caso habitual de reintento: la clave ya existe y no hace falta intentar insertar.
    let envio = (await pool.query(BUSCAR_POR_CLAVE, [clave])).rows[0];

    if (!envio) {
      // Puede que otra réplica esté insertando la misma clave en este instante:
      // ON CONFLICT resuelve la carrera y solo uno de los dos crea el envío.
      const insertado = await pool.query(INSERTAR_ENVIO, [clave, destinatario, direccion, hash, INSTANCE_ID]);
      if (insertado.rowCount === 1) {
        // Primer intento con esta clave: el envío queda confirmado en la base.
        envio = insertado.rows[0];
        respuesta.httpStatus = 201;
        seg.registrar('REGISTRADO', { envioId: envio.id });
      } else {
        envio = (await pool.query(BUSCAR_POR_CLAVE, [clave])).rows[0];
        if (!envio) throw new Error('Conflicto de clave sin envío asociado');
      }
    }

    if (respuesta.httpStatus === null) {
      // La clave ya existía: es un reintento. Se devuelve el envío original.
      if (envio.request_hash !== hash) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUTILIZADA',
          'Esta Idempotency-Key ya se usó con otros datos; genere una nueva para un envío distinto',
          { envioId: envio.id });
      }
      respuesta.httpStatus = 200;
      respuesta.repetido = true;
      seg.registrar('REPETIDO', { envioId: envio.id });
    }

    respuesta.cuerpo = { id: envio.id, destinatario: envio.destinatario, direccion: envio.direccion };

    await simularDemoraSiCorresponde(req);

    // Si el cliente dejó de esperar, el envío ya existe pero la respuesta no llega a nadie.
    if (res.destroyed) {
      seg.registrar('RESPUESTA_NO_ENTREGADA', {
        envioId: envio.id,
        httpStatus: respuesta.httpStatus,
        duracionMs: seg.duracionMs(),
        detalle: 'El cliente cerró la conexión antes de recibir la respuesta',
      });
      return;
    }

    if (respuesta.repetido) res.set('Idempotent-Replayed', 'true');
    res.status(respuesta.httpStatus).json(respuesta.cuerpo);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
