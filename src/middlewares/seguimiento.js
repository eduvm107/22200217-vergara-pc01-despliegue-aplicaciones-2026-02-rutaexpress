const { randomUUID } = require('node:crypto');
const { registrarEvento } = require('../tracking');
const { INSTANCE_ID } = require('../config');

const PATRON_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

// Identifica la réplica en cada respuesta y deja la traza de cada solicitud:
//   RECIBIDO -> (resultado del negocio) -> RESPONDIDO | CLIENTE_DESCONECTADO
// El request_id viene de Nginx (X-Request-ID) para cruzar esta traza con su access log.
module.exports = function seguimiento(req, res, next) {
  const inicio = performance.now();
  const recibido = req.get('X-Request-ID');
  const requestId = recibido && PATRON_REQUEST_ID.test(recibido) ? recibido : randomUUID();
  // El healthcheck de Docker consulta /health cada pocos segundos; no es tráfico de pruebas.
  const esHealthcheckInterno = req.get('X-Docker-Healthcheck') === '1';

  res.set('X-Instance-ID', INSTANCE_ID);
  res.set('X-Request-ID', requestId);

  const base = {
    requestId,
    metodo: req.method,
    ruta: req.path.slice(0, 200),
    ip: req.ip,
    idempotencyKey: req.get('Idempotency-Key')?.slice(0, 128) ?? null,
  };

  const duracionMs = () => Number((performance.now() - inicio).toFixed(3));

  req.seguimiento = {
    requestId,
    duracionMs,
    registrar(evento, extra = {}) {
      if (!esHealthcheckInterno) registrarEvento({ ...base, evento, ...extra });
    },
  };

  req.seguimiento.registrar('RECIBIDO');

  // 'close' se emite al terminar la respuesta o si la conexión se corta antes.
  res.on('close', () => {
    if (res.writableFinished) {
      req.seguimiento.registrar('RESPONDIDO', { httpStatus: res.statusCode, duracionMs: duracionMs() });
    } else {
      req.seguimiento.registrar('CLIENTE_DESCONECTADO', {
        duracionMs: duracionMs(),
        detalle: 'La conexión se cerró antes de enviar la respuesta',
      });
    }
  });

  next();
};
