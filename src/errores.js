// Error de negocio: tiene código HTTP y un código propio para el cliente.
// Cualquier otro Error se trata como fallo inesperado (HTTP 500).
class AppError extends Error {
  constructor(httpStatus, codigo, mensaje, extra = {}) {
    super(mensaje);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.codigo = codigo;
    this.envioId = extra.envioId ?? null;
  }
}

module.exports = { AppError };
