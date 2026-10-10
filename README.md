# envios-app — RutaExpress (PC01 Despliegue de aplicaciones)

Servicio de registro de envíos con **Node.js + Express + PostgreSQL**, desplegado con
**Docker Compose** detrás de **Nginx** (balanceo entre tres réplicas y límite de solicitudes).
Evita envíos duplicados cuando el cliente reintenta tras un timeout, aunque el reintento
llegue a otra réplica o ambos intentos lleguen al mismo tiempo.

- Imagen: [`eduardo30458/envios-app:1.0.0`](https://hub.docker.com/r/eduardo30458/envios-app)
- Base del proyecto: el repositorio de clase `container-nodejs` (Express + `pg`, usuario no
  root, Nginx con `upstream` y `limit_req`), ampliado para los requisitos de la práctica.

```
                 ┌──────────── Nginx :80 (host :8080) ────────────┐
Cliente  ──────► │ limit_req POST /envios: 2 r/s, burst 4 → 429   │
(Postman /       │ round-robin  ·  logs JSON (acceso y 429)        │
 scripts)        └───────┬──────────────┬──────────────┬──────────┘
                         ▼              ▼              ▼
                    app1:3000      app2:3000      app3:3000     (misma imagen, sin puertos al host)
                         └──────────────┼──────────────┘
                                        ▼
                         PostgreSQL :5432 (host :15432) ── volumen db_data
```

## Cómo reproducir

Requisitos: Docker Desktop (Compose v2) y Node.js 22 o superior (solo para los scripts de prueba).

```bash
cp .env.example .env          # los valores de ejemplo funcionan tal cual (Windows: copy .env.example .env)
docker compose pull           # descarga la imagen publicada en Docker Hub
docker compose up -d --wait   # db, app1, app2, app3 y nginx
node pruebas/ejecutar-todas.mjs
```

| Servicio | Acceso desde el host |
|---|---|
| API (Nginx) | `http://localhost:8080` |
| PostgreSQL (DBeaver) | `localhost:15432`, base/usuario/clave del `.env` |
| app1, app2, app3 | sin puerto publicado (solo red interna, puerto 3000) |

Para reconstruir y publicar la imagen:

```bash
docker build -t eduardo30458/envios-app:1.0.0 .
docker push eduardo30458/envios-app:1.0.0
docker rmi eduardo30458/envios-app:1.0.0 && docker pull eduardo30458/envios-app:1.0.0
```

## Contrato de la API

### `POST /envios`

| Cabecera | Obligatoria | Descripción |
|---|---|---|
| `Content-Type: application/json` | Sí | |
| `Idempotency-Key` | Sí | Identificador de la **operación**. Un UUID nuevo por cada envío que se quiere crear; **el mismo** en cada reintento de esa operación. |

```json
{ "destinatario": "Ana Torres", "direccion": "Av. Los Olivos 123, Lima" }
```

| Caso | HTTP | Cuerpo / cabeceras |
|---|---|---|
| Envío nuevo | **201** | `{ id, destinatario, direccion }` |
| Reintento (misma clave, mismos datos) | **200** | El mismo envío original + `Idempotent-Replayed: true` |
| Misma clave con otros datos | 422 | `IDEMPOTENCY_KEY_REUTILIZADA` |
| Falta la clave, JSON inválido o campos no texto | 400 | `{ error: { codigo, mensaje } }` |
| Supera el límite de Nginx | 429 | Lo responde Nginx; no llega a la aplicación |

Todas las respuestas de una réplica incluyen `X-Instance-ID` (`app1`, `app2` o `app3`) y
`X-Request-ID` (el id que asigna Nginx, para cruzar con sus logs).

```bash
curl -i -X POST http://localhost:8080/envios \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2a9e-0d7b-4b55-9a51-2f7f4c1c9e10" \
  -d '{"destinatario":"Ana Torres","direccion":"Av. Los Olivos 123, Lima"}'
```

### `GET /health`

Ejecuta `SELECT 1` en PostgreSQL. Responde `200 {"status":"ok","database":"connected","instance":"app1"}`
o `503 {"status":"error","database":"disconnected","instance":"app1"}` si la base no responde.

## Diseño de la solución

### Mecanismo contra duplicados: `Idempotency-Key` + restricción `UNIQUE`

- El cliente genera una clave por **operación de negocio** y la repite en cada reintento.
- La tabla `envios` tiene `UNIQUE (idempotency_key)`. La aplicación busca la clave; si no existe
  inserta con `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`.
- Es **PostgreSQL** quien decide quién crea el envío, no la réplica. Si app1 y app3 insertan la
  misma clave al mismo tiempo, la base hace esperar a la segunda transacción y luego no inserta
  nada; esa réplica lee el envío ya creado y lo devuelve con `200`. Un control en memoria no
  serviría, porque cada réplica tiene su propia memoria.
- **Reintento vs. envío intencional**: no se compara por destinatario y dirección (dos envíos
  reales pueden coincidir). Lo que distingue el caso es la clave: el mismo valor significa "es la
  misma operación"; una clave nueva significa "es otro envío", aunque los datos sean idénticos.
- `request_hash` (SHA-256 de destinatario y dirección) detecta el error de reutilizar una
  clave con otros datos (`422`), en lugar de devolver en silencio un envío distinto al pedido.

**Por qué no otras opciones:** un candado por destinatario y dirección bloquearía los envíos
legítimos repetidos; una caché en memoria o un `SELECT` previo sin restricción `UNIQUE` falla
cuando dos réplicas consultan al mismo tiempo; Redis agregaría otro servicio sin necesidad,
porque PostgreSQL ya es compartido por las tres réplicas y es la fuente de verdad.

### Modelo de datos (`db/init/01_schema.sql`)

| Objeto | Propósito |
|---|---|
| `envios` | Un registro por envío: `id` (identity), `idempotency_key` (UNIQUE), `destinatario`, `direccion`, `request_hash`, `instancia_creadora`, `creado_en`. |
| `eventos_intento` | Traza de cada solicitud como **eventos** que no se sobrescriben: `RECIBIDO` → `REGISTRADO` / `REPETIDO` / `ATENDIDO` / `RECHAZADO` / `FALLIDO` → `RESPONDIDO` o `CLIENTE_DESCONECTADO` / `RESPUESTA_NO_ENTREGADA`. Hora con microsegundos, método, ruta, réplica, IP, clave, `envio_id`, código HTTP, duración. |
| `v_intentos` | Una fila por solicitud: `resultado_servidor` (lo que hizo el backend) separado de `respuesta_cliente` (si la respuesta llegó o no). |
| `v_intentos_por_envio` | Todos los intentos relacionados con cada envío (reintentos, concurrencia). |

El script se monta en `/docker-entrypoint-initdb.d` y se ejecuta al crear el volumen por primera vez.

El registro por eventos se inspira en el tracking de una pasarela de pagos (estados que se
agregan, nunca se sobrescriben, y que no bloquean la respuesta al cliente): los eventos se
escriben en segundo plano, con un reintento, y si la base no responde quedan en
`docker compose logs` como `EVENTO_NO_PERSISTIDO`.

### Registro de intentos: tres puntos de vista

| Fuente | Qué acredita | Dónde |
|---|---|---|
| Backend | Resultado del servidor de cada solicitud que llegó a una réplica | Tablas/vistas de PostgreSQL (volumen `db_data`) |
| Nginx | Todas las solicitudes, incluidos los **429** que no llegan a la app y los **499** (cliente cerró la conexión) | `logs/nginx/acceso.jsonl`, `logs/nginx/rechazos_429.jsonl`, `logs/nginx/error.log` (carpeta del host) |
| Cliente | Lo que observó el cliente, incluidos los **timeouts** | `evidencias/cliente/*.jsonl` |

Las tres fuentes se relacionan por `Idempotency-Key` y por `request_id` (Nginx lo genera, lo
envía a la réplica en `X-Request-ID` y la réplica lo guarda y lo devuelve). Los logs de Nginx
no guardan el cuerpo ni datos personales: solo hora, IP, método, ruta, estado, réplica y clave.

### Nginx

- `upstream` round-robin con `app1`, `app2` y `app3`, usando `resolve` y el DNS de Docker para
  volver a encontrar una réplica que se detuvo y regresó.
- `limit_req_zone` por IP solo para `POST` (un `map` deja vacía la clave para otros métodos):
  `rate=2r/s`, `burst=4 nodelay` (la ráfaga se atiende de inmediato) y `limit_req_status 429`.
- Nginx no reintenta un `POST` en otra réplica (no es idempotente para el proxy); un `GET /health`
  sí se reintenta si una réplica no responde.

## Simulación de la demora (prueba de timeout)

- Se activa por solicitud con la cabecera `X-Simular-Demora: 5000`, y solo si la variable
  `PERMITIR_SIMULACION=true`.
- La espera ocurre **después** de confirmar el `INSERT` y antes de responder
  (`await new Promise(resolve => setTimeout(resolve, ms))`).
- Para el reintento basta con no enviar la cabecera.
- **Para retirarla por completo:** poner `PERMITIR_SIMULACION=false` en `.env` y ejecutar
  `docker compose up -d` (recrea las réplicas sin modificar el código). Sin la variable, el valor
  por defecto es `false`.

## Pruebas

`node pruebas/ejecutar-todas.mjs` ejecuta todo en orden; cada script también puede correrse solo
(`npm run prueba:timeout`, etc.). Cada prueba deja su salida en `evidencias/salidas/` y lo que
observó el cliente en `evidencias/cliente/`.

| Script | Qué demuestra |
|---|---|
| `01-balanceo` | 12 `GET /health` por debajo del límite, respondidas por app1, app2 y app3 |
| `02-continuidad` | Se detiene app2 mientras el cliente consulta; app1 y app3 siguen; se restablece app2 y vuelve a recibir tráfico. Registra errores del cliente y del proxy |
| `03-timeout-reintento` | Registro confirmado antes del timeout de 2 s del cliente; reintento atendido por otra réplica; un solo envío |
| `04-concurrencia` | Dos `POST` simultáneos con la misma clave en réplicas distintas: un 201, un 200, un solo envío |
| `05-intencionales` | Dos envíos nuevos con los mismos datos y claves distintas: dos registros |
| `06-persistencia` | 3 envíos; `docker compose down` + `up`; mismos ids y datos; reintento sin duplicar |
| `07-rafaga-429` | 20 `POST` simultáneos: cantidad, duración y conteo de códigos; luego 1 r/s sin rechazos |
| `08-registro-429` | Consulta del log de 429; se recrea nginx y los registros permanecen |

Consultas para DBeaver: `pruebas/consultas.sql`.

## Estructura

```
├── server.js                 # arranque y apagado ordenado (SIGTERM)
├── src/
│   ├── config.js             # variables de entorno
│   ├── db.js                 # pool de PostgreSQL
│   ├── tracking.js           # registro de eventos en segundo plano
│   ├── errores.js            # AppError (errores de negocio)
│   ├── middlewares/          # seguimiento (X-Instance-ID, eventos) y errores
│   └── rutas/                # /health y /envios
├── db/init/01_schema.sql     # tablas, índices y vistas
├── nginx/nginx.conf
├── docker-compose.yml · Dockerfile · .dockerignore · .env.example
├── pruebas/                  # scripts de prueba y consultas SQL
├── evidencias/               # salidas, vista del cliente, logs de Nginx, capturas
└── respuestas/               # preguntas de análisis
```

## Observaciones

- **IP del cliente:** en Docker Desktop las solicitudes desde el host llegan a Nginx desde la
  puerta de enlace de la red de Docker (`172.x.0.1`); en un servidor real sería la IP de la oficina.
- **Ids correlativos:** el reintento habitual se resuelve con una búsqueda previa y no consume la
  secuencia. Solo en una carrera simultánea el `INSERT` perdedor consume un valor, por lo que
  podría haber un salto en los ids. No es un envío perdido.
- **Límites:** las tres réplicas comparten una sola base y un solo Nginx; si alguno de ellos cae,
  el servicio se interrumpe aunque las réplicas estén sanas.
