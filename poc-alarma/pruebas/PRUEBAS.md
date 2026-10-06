# Pruebas con el hardware

Orden pensado para que, si algo falla, se sepa en qué eslabon esta el problema.
Antes de tocar placas, el servidor se puede probar solo con `simular.js`.

## 0. Servidor (sin hardware)

1. Despliega: `cd deploy && bash desplegar_vps.sh` (el script verifica el acceso publico).
2. Abre la pagina y crea tu cuenta. Ajustes > Vivienda > Administrar > "Generar token nuevo" y guarda el `hv_...`.
3. Prueba con el simulador (desde cualquier computadora con Node 18+):
   ```
   node pruebas/simular.js --url http://sentinelhome.ddns.net:8080 --token hv_XXXX registro
   ```
   Deben aparecer 3 sensores con la etiqueta "Nuevo". Si no: token o URL incorrectos.
4. Arma la casa en la app y corre `... alarma`. Debe llegar el push. En el log del servidor
   (`docker logs -f alarma_backend`) aparecen las lineas de medicion de entrega (ver 4).
5. Con `... camara` abierto en otra terminal, repite `alarma` (con la alarma apagada antes):
   debe tomar 3 fotos y verse la galeria en la app.

## 1. Hub (nodo_sensor.ino)

- Configura `WIFI_*`, `BACKEND_BASE` (http, sin cifrado: `http://sentinelhome.ddns.net:8080`) y `DEVICE_TOKEN` (`hv_...`).
- Serial a 115200. Esperado: `[WiFi] Conectado`, `[ESP-NOW] Escuchando`, y cada ~30 s `[Latido] nodos=... codigo=200`.
- `codigo=401` o `403` = token incorrecto. `codigo=-1` = sin ruta al servidor (URL o puerto).
- En la app, el banner "El concentrador no se comunica" debe desaparecer.
- Buzzer en GPIO 4: "Probar la sirena" en Ajustes debe hacerlo sonar (y parpadear el LED de GPIO 2).
  Si solo se oye un "clic", es un buzzer pasivo.

## 2. Nodo C3 (nodo_c3.ino)

- Copia la MAC del hub (la imprime al arrancar) en `MAC_RECEPTOR`.
- Serial del C3: `[Enlace] Receptor encontrado en el canal N`. Sin eso no hay comunicacion.
- Al encender debe aparecer en la app, en ~30 s, el nodo `c3-xxxxxx` con sus sensores "Nuevo"
  (el PIR despues de 45 s de estabilizacion).
- Abre y cierra el contacto: el estado cambia en la app en menos de 2 s. Con la casa armada suena la sirena.
- Apaga el C3 y espera ~2 min: debe llegar el aviso "Un nodo dejo de responder".
- Apaga el hub y espera ~3 min: debe llegar "Concentrador sin conexion".

## 3. Camara (camara_ov5640.ino)

- Descomenta tu placa, activa PSRAM, pon Wi-Fi, URL y token.
- Serial: `Sensor detectado, PID 0x5640 (OV5640)`. Si dice "no es un OV5640" o falla el inicio, revisa pines y el cable plano.
- En la app: "Tomar foto" -> la foto aparece en la galeria en pocos segundos.
- "Ver en vivo" -> video unos segundos. Si va a saltos, baja `TAMANO_VIVO` a QVGA.
- Imagen de cabeza: `VOLTEAR_VERTICAL = true`. Imagen borrosa: gira la lente (enfoque manual).
- Alarma real: la camara toma 3 fotos sola. La alarma debe sonar aunque la camara este desconectada.

## 4. Notificaciones lentas: como leer el log

`docker logs -f alarma_backend` muestra, por cada alarma, tres lineas:

```
Alarma recibida: el concentrador tardo A ms en avisar desde que detecto el evento.
Push ID enviado a N de N dispositivo(s); el servicio de push lo acepto en B ms.
Push ID recibido en un telefono C ms despues de salir del servidor (1/N).
```

- **A grande** (> 1000 ms): la demora esta en el hub o su Wi-Fi (reintentos, red lenta).
- **B grande**: el servicio de Apple/Google tarda en aceptar el aviso (red del VPS hacia ellos).
- **C grande** con B pequeno: el aviso llego a Apple/Google rapido pero el telefono lo entrega tarde.
  Casi siempre es ahorro de bateria del telefono o del navegador: quita la restriccion de bateria a la
  app instalada (Android) o revisa que la PWA este instalada en la pantalla de inicio (iPhone).
- **Falta la linea C**: el telefono nunca confirmo; el aviso no llego o el service worker no se actualizo
  (cierra y reabre la app una vez tras actualizar).
