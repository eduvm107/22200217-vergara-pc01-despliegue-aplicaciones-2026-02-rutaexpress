const { AppError } = require('../errores');

function enviarError(res, httpStatus, codigo, mensaje) {
  if (res.headersSent || res.destroyed) return;
  res.status(httpStatus).json({ error: { codigo, mensaje } });
}

function rutaNoEncontrada(req, res) {
  req.seguimiento.registrar('RECHAZADO', { detalle: 'RUTA_NO_ENCONTRADA' });
  enviarError(res, 404, 'RUTA_NO_ENCONTRADA', `No existe ${req.method} ${req.path}`);
}

// eslint-disable-next-line no-unused-vars
function manejadorErrores(err, req, res, next) {
  // Errores de negocio y de validación: respuesta controlada.
  if (err instanceof AppError) {
    req.seguimiento.registrar('RECHAZADO', { envioId: err.envioId, detalle: err.codigo });
    return enviarError(res, err.httpStatus, err.codigo, err.message);
  }

  // Errores que lanza express.json() al leer el cuerpo.
  if (err.type === 'entity.parse.failed') {
    req.seguimiento.registrar('RECHAZADO', { detalle: 'JSON_INVALIDO' });
    return enviarError(res, 400, 'JSON_INVALIDO', 'El cuerpo no es un JSON válido');
  }
  if (err.type === 'entity.too.large') {
    req.seguimiento.registrar('RECHAZADO', { detalle: 'CUERPO_DEMASIADO_GRANDE' });
    return enviarError(res, 413, 'CUERPO_DEMASIADO_GRANDE', 'El cuerpo supera el tamaño permitido');
  }

  // Cualquier otra cosa es un fallo inesperado (por ejemplo, la base no responde).
  console.error(JSON.stringify({ tipo: 'ERROR_NO_CONTROLADO', requestId: req.seguimiento.requestId, error: err.message }));
  req.seguimiento.registrar('FALLIDO', { detalle: String(err.message).slice(0, 300) });
  return enviarError(res, 500, 'ERROR_INTERNO', 'No se pudo procesar la solicitud');
}

module.exports = { rutaNoEncontrada, manejadorErrores };
