# Deteccion de la camara por ONVIF

El backend se suscribe a los eventos ONVIF de la Mercusys MC210 (persona y movimiento
que la propia camara ya calcula) y los convierte en eventos guardados, avisos y fotos.
No analiza video y no hay IA adicional. Por omision **no activa la sirena ni cambia el estado de la alarma**; solo si se define `ONVIF_SIRENA` (ver mas abajo).

```
MC210 --(PullPoint, long poll)--> servicio.js --> estados.js --> eventos_camara.js
                                                                   |-- tabla eventos_camara
                                                                   |-- notificar() (push)
                                                                   '-- solicitarFotoAlarma()  -> camara_rtsp.js -> ffmpeg (RTSP solo al pedir una foto/vivo)
```

El ESP32 no interpreta nada: solo reenvia el puerto 2020 (ONVIF) y 554 (RTSP) por el tunel.

## Archivos

| Archivo | Funcion |
|---|---|
| `cliente.js` | SOAP/ONVIF: WS-Security con correccion de reloj, GetServices, GetEventProperties, PullPoint, Renew, Unsubscribe. Reescribe las IP internas de la camara a `ONVIF_HOST:ONVIF_PUERTO`. |
| `servicio.js` | Mantiene la suscripcion: renueva, recrea si caduca o falla, reconecta con espera creciente. |
| `estados.js` | Estado por camara/detector/regla. Primer mensaje tras conectar = sincronizacion; solo cuentan los cambios reales false<->true (da igual si dice Initialized o Changed); repetidos ignorados; cooldown; desconocido al perder la conexion; si llega persona, el movimiento simultaneo no genera segundo aviso. |
| `registro_xml.js` | Guarda el XML original (rotado) con usuario, clave y nonce ocultos. |
| `probar.js` | Prueba manual contra la camara real, sin base de datos. |
| `../eventos_camara.js` | Pegamento con la base, los avisos y las fotos; rutas `GET /camara/eventos` y `GET /camara/deteccion`. |
| `../camara_rtsp.js` | Agente que, a peticion del backend, saca fotos o video con ffmpeg. RTSP nunca queda abierto en reposo. |

## Configuracion (`deploy/.env`)

Todo viene apagado por omision.

| Variable | Por omision | Para que |
|---|---|---|
| `ONVIF_ACTIVO` | `0` | `1` enciende el servicio |
| `ONVIF_VIVIENDA_ID` | | id real de la vivienda (debe existir en la tabla `viviendas`) |
| `ONVIF_HOST` / `ONVIF_PUERTO` | `10.8.0.2` / `2020` | Direccion alcanzable de la camara (extremo del tunel) |
| `ONVIF_USUARIO` / `ONVIF_CLAVE` | | cuenta de la camara. Solo en el `.env` del servidor |
| `ONVIF_ALERTAR` | `persona` | detectores que avisan: `persona`, `movimiento` o ambos |
| `ONVIF_SIRENA` | vacio | `movimiento` y/o `persona`: con la casa armada, la deteccion marca la alarma y enciende la salida audible. Vacio = nunca suena |
| `ONVIF_SIRENA_S` | `30` | segundos que suena |
| `ONVIF_RETARDO_SALIDA_S` | `60` | tras armar, la camara no avisa ni suena durante estos segundos |
| `ONVIF_SOLO_ARMADO` | `1` | solo avisa con el sistema armado (siempre se registra el evento) |
| `ONVIF_LOG_XML` | vacio | ruta del registro XML original (sin credenciales) |
| `CAMARA_RTSP_ACTIVO` | `0` | enciende el agente de fotos/video bajo demanda |
| `CAMARA_TOKEN` | vacio | normalmente vacio: el agente usa un token interno del servidor (no necesitas el token de la vivienda) |

Los demas ajustes (cooldowns, ventana de sincronizacion, duracion de la suscripcion) estan en
`deploy/.env.example`.

## Probar con la camara real (en el VPS)

1. Que el tunel este arriba: `bash firmware/puente_camara_s3/vps/verificar_puente.sh`.
2. Que el contenedor llegue a la camara (esto **no** se ha podido verificar sin el VPS):

   ```
   docker exec alarma_backend wget -T5 -qO- http://10.8.0.2:2020/ ; echo "codigo $?"
   ```

   Cualquier respuesta HTTP (aunque sea 404 o 405) vale; "timed out" significa que Docker no enruta
   hacia `wg0` y hay que permitirlo (ufw route / regla en `DOCKER-USER`).
3. Prueba sin tocar nada del sistema, caminando frente a la camara:

   ```
   docker exec -e ONVIF_HOST=10.8.0.2 -e ONVIF_USUARIO=... -e ONVIF_CLAVE=... \
     -e ONVIF_LOG_XML=/tmp/onvif.xml.log alarma_backend node onvif/probar.js 90
   ```

   Pasa por la terminal el usuario y la clave; no los pegues en un chat. Revisa:
   - que aparezcan `RuleEngine/PeopleDetector/People` y `RuleEngine/CellMotionDetector/Motion`;
   - que al aparecer una persona salga `persona=true` y luego `persona=false` al irse;
   - que el motor diga `EVENTO` y `ALERTA` una sola vez por entrada, no por cada mensaje.
4. Si todo cuadra, en `deploy/.env`: `ONVIF_ACTIVO=1`, `ONVIF_VIVIENDA_ID`, usuario y clave, `CAMARA_RTSP_ACTIVO=1`;
   reconstruye (`docker compose up -d --build backend`) y mira `docker logs alarma_backend`.

## Alarma disparada por la camara

Con `ONVIF_SIRENA=movimiento`, un movimiento detectado con la casa **armada** (y pasado el retardo de salida)
marca la alarma, avisa con prioridad maxima, pide fotos y enciende la salida audible durante `ONVIF_SIRENA_S`.

- **Una persona cuenta como movimiento.** Si no, el motor descartaria el movimiento cuando llega una persona y
  el intruso no haria sonar nada.
- **Como suena:** la sirena la decide localmente el concentrador cuando un nodo le avisa; el servidor solo refleja
  ese estado. Para la camara se usa lo unico que el concentrador obedece del servidor: la salida audible
  (`actuador_activo`). El concentrador consulta el estado cada pocos segundos, asi que tarda ese intervalo en sonar.
- **Se apaga:** sola al cumplirse el tiempo; al apagar la alarma desde la aplicacion; al desarmar; y si el servidor
  se reinicia mientras suena (la alarma queda marcada como de la camara y al arrancar se apaga).
- **Modo silencioso:** igual que con un sensor, registra y avisa pero no enciende la salida.
- **Si ya hay una alarma sonando** (por ejemplo de un sensor), no se duplica.
- **Falsas alarmas:** el movimiento de la MC210 es muy sensible (luz, sombras, cortinas). Ajusta la sensibilidad y
  la zona de deteccion en la aplicacion de la camara, y valora usar `persona` en lugar de `movimiento`.

## Pruebas

`npm test` (51 pruebas, ~1.5 min). Usan una camara ONVIF simulada (`test/camara_onvif_falsa.js`),
ffmpeg con una fuente de prueba y, en la de extremo a extremo, PostgreSQL en memoria (PGlite).

Cubren: sincronizacion inicial sin alertas, cambios reales, repetidos, cooldown, desconocido al
desconectar, persona+movimiento sin doble aviso, renovacion y recreacion de la suscripcion,
reconexion tras caida, credenciales incorrectas, reescritura de IP interna, XML sin credenciales,
sistema desarmado, que la alarma nunca se modifique y que RTSP no se abra en reposo.

## Lo que solo se comprueba con hardware

- Que la MC210 publique esos topics y los valores `true`/`false` como se describio. `probar.js` lo muestra.
- Si la camara manda `Initialized` en cada cambio (el motor no depende de eso).
- Latencia real y cuantas suscripciones simultaneas admite.
- Alcance desde el contenedor hasta `10.8.0.2` (punto 2).
- Consumo de CPU/memoria de ffmpeg en el VPS al pedir video.
