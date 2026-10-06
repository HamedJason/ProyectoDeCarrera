# Sistema escalable de seguridad residencial — Prueba de concepto

Proyecto de Carrera, Ingeniería en Computación
Universidad Autónoma de Baja California, Facultad de Ciencias Químicas e Ingeniería, Tijuana

Este repositorio contiene la prueba de concepto reducida del Taller 5. Su objetivo
no es entregar el sistema terminado, sino comprobar que la arquitectura elegida en
el Taller 4 es viable, haciendo que un dato real recorra la cadena completa desde
una entrada física hasta una pantalla en el teléfono.

> **Para ponerlo en marcha, seguir [PASOS.md](PASOS.md).** Contiene el orden exacto
> de despliegue, los comandos de verificación de cada etapa y una tabla de fallas
> comunes.

## Estado actual

| Componente | Estado |
|---|---|
| Firmware del nodo sensor | Desarrollado, pendiente de cargar en la placa |
| Backend y endpoints | Desarrollado, pendiente de desplegar |
| Estructura de base de datos | Definida en `schema.sql` |
| Frontend | Desarrollado, pendiente de ejecutar contra el backend |
| Montaje físico | Provisional con push button. Los sensores MC-38 llegan a partir del 22 de septiembre |
| Pruebas de la cadena completa | Pendientes, programadas para la semana del 22 al 28 de septiembre |

### Hardware del proyecto

| Componente | Modelo | Cantidad |
|---|---|---|
| Controlador principal | ESP32 DevKit V1 | 1 |
| Nodos inalámbricos | ESP32-C3 SuperMini | 8 |
| Cámara | ESP32-S3 CAM con sensor OV5640 | 1 |
| Sensores de apertura | MC-38 con cable | 10 |
| Interruptores reed | MKA-0710 | 10 |
| Sensores de movimiento | PIR AM312 | 4 |
| Salida audible | Mini bocina 12 V PS-89 | 1 |

El PIR AM312 opera entre 2.7 y 12 V con salida de 3.3 V, por lo que se conecta
directamente al ESP32 sin divisor de voltaje. A diferencia del HC-SR501 no tiene
potenciómetros de ajuste y su retardo es fijo, lo que se tomará en cuenta al medir
falsos positivos.

La bocina de 12 V **no** debe conectarse a un GPIO. Requiere un relevador o un
transistor MOSFET y una fuente independiente, que todavía no se han adquirido.

La comunicación MQTT sobre ESP32 se probó de forma preliminar antes de este taller,
como verificación independiente del transporte previsto para el prototipo alfa.

## Cadena planteada

```
Entrada física  ->  ESP32  ->  Backend en la nube  ->  PostgreSQL  ->  App móvil
 (push button)     (Wi-Fi)     (Node + Express)                        (React Native)
```

Adicionalmente se incluye el camino inverso para el control del actuador:

```
App móvil  ->  POST /comando  ->  Backend  ->  GET /comando (el ESP32 consulta)  ->  LED
```

## Estructura del repositorio

```
ProyectoDeCarrera/
├── firmware/nodo_sensor/nodo_sensor.ino   Firmware del ESP32
├── backend/
│   ├── server.js                          API REST
│   ├── db.js                              Conexión a PostgreSQL
│   ├── schema.sql                         Estructura de la tabla
│   ├── consultas.sql                      Consultas de recuperación
│   └── .env.example                       Plantilla de variables de entorno
├── deploy/
│   ├── docker-compose.yml                 Base de datos, backend y servidor web
│   ├── Caddyfile                          Dominio y HTTPS automático
│   └── .env.example                       Plantilla de variables del despliegue
├── frontend/App.js                        Base inicial del frontend
├── docs/                                  Diagramas de conexión, de flujo y de la base de datos
│   └── talleres/                          Documentos de los talleres 4, 5, 6 y 7 (Word)
└── pruebas/                               Simulador y scripts de prueba
```

## Decisiones de la etapa

Estas decisiones aplican solo a la prueba de concepto y no modifican la arquitectura
aprobada en el Taller 4.

| Decisión | Motivo |
|---|---|
| HTTPS en lugar de MQTT | La actividad acepta `POST /mediciones`. Montar broker, TLS y credenciales consumiría tiempo que hace falta para demostrar la cadena completa. MQTT se implementa en el prototipo alfa. |
| Push button en lugar de sensor reed | El reed magnético todavía no está disponible. Ambos son contactos secos, por lo que el cableado y el firmware no cambian al sustituirlo. |
| LED en lugar de sirena | La sirena de 12 V requiere relevador y fuente independiente. El LED demuestra el mismo camino de control remoto con menor riesgo eléctrico. |
| Polling del comando | Con HTTPS no existe un canal persistente hacia el dispositivo. El polling cada 2 segundos es suficiente para la demostración y se sustituye por MQTT después. |

## Instalación

### Despliegue en el VPS (recomendado)

Todo el despliegue está en `deploy/` y se levanta con Docker Compose: base de
datos, backend y servidor web con HTTPS automático.

```bash
cd deploy
cp .env.example .env     # cambiar POSTGRES_PASSWORD y DEVICE_TOKEN
docker compose up -d --build
```

Caddy solicita y renueva el certificado de Let's Encrypt por su cuenta. La tabla
de la base de datos se crea sola al arrancar el backend.

El dominio se configura en `deploy/Caddyfile` y debe coincidir con `BACKEND_BASE`
en el firmware.

**Los pasos detallados, desde Windows, están en [PASOS.md](PASOS.md).**

### Backend en local, para desarrollo

```bash
cd backend
npm install
copy .env.example .env    # en Windows; en Linux o Mac usar cp
npm start
```

### Firmware

1. Abrir `firmware/nodo_sensor/nodo_sensor.ino` en el IDE de Arduino.
2. Instalar la librería **ArduinoJson** versión 7 desde el gestor de librerías.
3. Editar `WIFI_SSID`, `WIFI_PASSWORD`, `BACKEND_BASE` y `DEVICE_TOKEN`.
4. Seleccionar la placa *ESP32 Dev Module* y cargar.
5. Abrir el monitor serial a 115200 baudios para ver los eventos y las latencias.

### Frontend

```bash
cd frontend
npm install
npx expo start
```

Editar la constante `BACKEND_BASE` en `App.js` para que apunte al backend
desplegado. Debe ser la URL pública, no `localhost`, porque la aplicación corre
en el teléfono y no en la computadora.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/salud` | Verifica que el servicio y la base de datos respondan |
| `POST` | `/mediciones` | Registra una medición. Requiere el encabezado `X-Device-Token` |
| `GET` | `/mediciones` | Devuelve el histórico. Acepta `vivienda_id` y `limite` |
| `GET` | `/mediciones/ultima` | Devuelve únicamente el dato más reciente |
| `GET` | `/comando` | El ESP32 consulta el estado del actuador |
| `POST` | `/comando` | El frontend cambia el estado del actuador |

### Ejemplo de medición válida

```json
{
  "vivienda_id": "casa-001",
  "zona": "entrada",
  "nodo_id": "nodo-01",
  "sensor_id": "sensor-puerta-01",
  "variable": "estado_puerta",
  "valor": 1,
  "unidad": "estado",
  "numero_registro": 7
}
```

Respuesta `201`:

```json
{ "ok": true, "mensaje": "Medicion registrada correctamente.", "medicion": { "...": "..." } }
```

### Ejemplo de dato incorrecto

Si falta un campo obligatorio o `valor` no es numérico, la API responde `400` y
enumera los problemas encontrados en lugar de devolver un error genérico:

```json
{
  "ok": false,
  "mensaje": "La medicion no pudo registrarse porque el dato es incorrecto.",
  "errores": [
    "Falta el campo obligatorio \"sensor_id\".",
    "El campo \"valor\" debe ser numerico."
  ]
}
```

## Alcance no cubierto en esta etapa

Conforme a lo indicado en la actividad, esta prueba de concepto no incluye
autenticación completa de usuarios, lógica de negocio definitiva, diseño
adaptable terminado, todas las pantallas, documentación formal de la API,
calibración ni pruebas unitarias.

El token del dispositivo es un control mínimo para evitar escrituras anónimas
durante las pruebas y no representa el esquema de seguridad final del proyecto.
