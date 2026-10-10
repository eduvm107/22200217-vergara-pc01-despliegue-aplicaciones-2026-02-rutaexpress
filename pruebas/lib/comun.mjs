// Utilidades compartidas por los scripts de prueba.
// El cliente de pruebas representa al frontend: envía las solicitudes a Nginx (puerto 8080)
// y deja su propia evidencia (lo que el cliente observó) en evidencias/cliente/*.jsonl.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

export const nuevaClave = () => randomUUID();
export const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hora local de Lima con milisegundos, para leer la evidencia junto a la de la base y Nginx.
export function horaLima(fecha = new Date()) {
  const local = new Date(fecha.getTime() - 5 * 60 * 60 * 1000);
  return local.toISOString().replace('T', ' ').replace('Z', '-05:00');
}

// Bitácora de la prueba: imprime en consola y guarda una copia en evidencias/.
export function crearBitacora(nombre) {
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  const dirCliente = path.join(RAIZ, 'evidencias', 'cliente');
  const dirSalidas = path.join(RAIZ, 'evidencias', 'salidas');
  mkdirSync(dirCliente, { recursive: true });
  mkdirSync(dirSalidas, { recursive: true });
  const archivoJsonl = path.join(dirCliente, `${nombre}_${sello}.jsonl`);
  const archivoTxt = path.join(dirSalidas, `${nombre}_${sello}.txt`);

  const log = (...partes) => {
    const linea = partes.map((p) => (typeof p === 'string' ? p : JSON.stringify(p, null, 2))).join(' ');
    console.log(linea);
    appendFileSync(archivoTxt, linea + '\n');
  };
  const registrar = (obj) => appendFileSync(archivoJsonl, JSON.stringify(obj) + '\n');

  log(`Evidencia del cliente: ${path.relative(RAIZ, archivoJsonl)}`);
  log(`Salida de la prueba:   ${path.relative(RAIZ, archivoTxt)}`);
  return { log, registrar };
}

// Envía una solicitud y registra lo que vio el cliente.
// resultado_cliente: RESPUESTA_RECIBIDA | TIMEOUT_CLIENTE | ERROR_RED
export async function solicitar(bitacora, { etiqueta, metodo = 'GET', ruta, cuerpo, clave, demoraMs, timeoutMs = 10000 }) {
  const headers = {};
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  if (clave) headers['Idempotency-Key'] = clave;
  if (demoraMs) headers['X-Simular-Demora'] = String(demoraMs);

  const inicio = new Date();
  const t0 = performance.now();
  const registro = {
    etiqueta,
    inicio_cliente: horaLima(inicio),
    metodo,
    ruta,
    idempotency_key: clave ?? null,
    simular_demora_ms: demoraMs ?? null,
    timeout_cliente_ms: timeoutMs,
  };

  try {
    const res = await fetch(BASE_URL + ruta, {
      method: metodo,
      headers,
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* respuesta no JSON */ }
    Object.assign(registro, {
      resultado_cliente: 'RESPUESTA_RECIBIDA',
      http_status: res.status,
      x_instance_id: res.headers.get('x-instance-id'),
      x_request_id: res.headers.get('x-request-id'),
      idempotent_replayed: res.headers.get('idempotent-replayed') === 'true',
      envio_id: json?.id ?? null,
      instance: json?.instance ?? null,
      error_codigo: json?.error?.codigo ?? null,
    });
  } catch (err) {
    const esTimeout = err.name === 'TimeoutError';
    Object.assign(registro, {
      resultado_cliente: esTimeout ? 'TIMEOUT_CLIENTE' : 'ERROR_RED',
      http_status: null,
      x_instance_id: null,
      error: esTimeout ? `El cliente dejó de esperar a los ${timeoutMs} ms` : (err.cause?.code || err.message),
    });
  }

  registro.fin_cliente = horaLima();
  registro.duracion_ms = Number((performance.now() - t0).toFixed(1));
  bitacora.registrar(registro);
  return registro;
}

// Ejecuta un comando (sin shell) y devuelve su salida.
export function ejecutar(comando, args, { entrada } = {}) {
  return new Promise((resolve) => {
    const proceso = spawn(comando, args, { cwd: RAIZ });
    let salida = '';
    let error = '';
    proceso.stdout.on('data', (d) => { salida += d; });
    proceso.stderr.on('data', (d) => { error += d; });
    proceso.on('close', (codigo) => resolve({ codigo, salida, error }));
    proceso.on('error', (err) => resolve({ codigo: -1, salida, error: err.message }));
    if (entrada !== undefined) proceso.stdin.end(entrada);
    else proceso.stdin.end();
  });
}

export async function compose(...args) {
  const r = await ejecutar('docker', ['compose', ...args]);
  if (r.codigo !== 0) throw new Error(`docker compose ${args.join(' ')} falló:\n${r.error}`);
  return (r.salida + r.error).trim();
}

const PSQL = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -P pager=off';

// Consulta en PostgreSQL (contenedor db) y devuelve la tabla en texto, tal como la mostraría psql.
export async function sqlTabla(consulta) {
  const r = await ejecutar('docker', ['compose', 'exec', '-T', 'db', 'sh', '-c', PSQL], { entrada: consulta });
  if (r.codigo !== 0) throw new Error(`Consulta fallida:\n${r.error}`);
  return r.salida.trimEnd();
}

// Consulta en PostgreSQL y devuelve las filas como objetos.
export async function sqlFilas(consulta) {
  const envuelta = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${consulta.trim().replace(/;$/, '')}) t;`;
  const r = await ejecutar('docker', ['compose', 'exec', '-T', 'db', 'sh', '-c', `${PSQL} -At`], { entrada: envuelta });
  if (r.codigo !== 0) throw new Error(`Consulta fallida:\n${r.error}`);
  return JSON.parse(r.salida.trim());
}

// Logs de Nginx montados en el host (logs/nginx).
export const LOGS_NGINX = path.join(RAIZ, 'logs', 'nginx');

export function leerArchivo(nombre) {
  const ruta = path.join(LOGS_NGINX, nombre);
  return existsSync(ruta) ? readFileSync(ruta, 'utf8') : '';
}

export function leerJsonl(nombre) {
  return leerArchivo(nombre).split('\n').filter(Boolean).map((linea) => JSON.parse(linea));
}

// Escapa un texto para usarlo como literal SQL en las consultas de evidencia.
export const lit = (texto) => `'${String(texto).replace(/'/g, "''")}'`;

export function contar(lista, campo) {
  return lista.reduce((acc, item) => {
    const k = String(item[campo] ?? 'sin dato');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

export function veredicto(bitacora, ok, mensaje) {
  bitacora.log(`${ok ? '✔ CUMPLE' : '✘ NO CUMPLE'}: ${mensaje}`);
  if (!ok) process.exitCode = 1;
}
