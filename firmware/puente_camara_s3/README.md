# Puente de la cámara MC210 con ESP32-S3 (WireGuard hacia el VPS)

Lleva la cámara Tapo MC210 hasta Sentinel Home sin Raspberry Pi y sin tocar el router de la casa.

```
MC210 ──WiFi──► ESP32-S3 (AP + STA, NAT) ──WiFi──► router de casa ──Internet──► VPS OVH
 192.168.4.2      192.168.4.1 / 10.8.0.2                                          10.8.0.1
                  └──────────── túnel WireGuard (UDP 51820, lo inicia el ESP32) ────────────┘
```

El ESP32 **no procesa video**: solo reenvía paquetes. FFmpeg (o MediaMTX) corre en el VPS, que pide el
cuadro o el flujo a `10.8.0.2:554` (RTSP) y `10.8.0.2:2020` (ONVIF). El ESP32 reenvía esos dos puertos
a la cámara con `portmap … VPN`. Ningún puerto de la cámara queda expuesto en tu red ni en Internet.

## Decisión de diseño: firmware oficial, sin fork

Se usa el binario precompilado de [esp32_nat_router](https://github.com/martin-ger/esp32_nat_router)
(trae ESP32-S3). Ya incluye NAT, WireGuard, reservas DHCP y mapeo de puertos por la interfaz del túnel
(`portmap add TCP <ext> <ip> <puerto> VPN`). Solo se haría un fork si una prueba con hardware demuestra
que falta algo. Por eso este módulo no contiene código C: contiene configuración, scripts del VPS y pruebas.

## Contenido

| Archivo | Para qué |
|---|---|
| `esp32/comandos_router.txt` | Comandos de consola del ESP32 (WiFi, IP fija de la cámara, túnel, puertos). |
| `vps/instalar_wireguard.sh` | Configura WireGuard en el VPS, genera claves y el comando `set_vpn` para el ESP32. |
| `vps/puente.env.ejemplo` | Plantilla de credenciales de la cámara (copiar a `puente.env`, no subir a git). |
| `vps/verificar_puente.sh` | Handshake, ping, puertos 554/2020, ONVIF y RTSP. Una línea PASA/FALLA por prueba. |
| `vps/foto_camara.sh` | Una foto JPEG por RTSP a través del túnel (base de la foto de alarma). |
| `vps/medir_rendimiento.sh` | Pérdida del túnel y caudal real del flujo; decide si alcanza `stream1` o solo `stream2`. |
| `pruebas/prueba_estatica.sh` | Pruebas sin hardware (sintaxis, shellcheck, secretos, instalador simulado). |
| `PRUEBAS_HARDWARE.md` | Lo que solo se puede probar con la placa, la cámara y el VPS. |

## Puesta en marcha

1. **Flashear el ESP32-S3** con el firmware oficial. Desde el instalador web
   (<https://martin-ger.github.io/esp32_nat_router/>, navegador con Web Serial) o con esptool:
   ```
   esptool.py --chip esp32s3 --before default_reset --after hard_reset write_flash -z --flash_size detect \
     0x0 firmware_esp32s3/bootloader.bin  0x8000 firmware_esp32s3/partition-table.bin \
     0xf000 firmware_esp32s3/ota_data_initial.bin  0x20000 firmware_esp32s3/esp32_nat_router.bin
   ```
2. **Cámara**: en la app Tapo crea la *cuenta de la cámara* (Ajustes avanzados) y confirma que ONVIF
   está activo. Anota la MAC de la cámara.
3. **VPS**: copia la carpeta `vps/` y ejecuta
   `sudo bash instalar_wireguard.sh --ip-publica <IP_DEL_VPS>`. Abre **UDP 51820** en el firewall de OVH.
   El script deja el comando `set_vpn` en `/root/puente_esp32_comandos.txt` (permisos 600).
4. **ESP32**: sigue `esp32/comandos_router.txt` por la consola serie, pegando la línea `set_vpn` del paso 3.
   Borra ese archivo del VPS después.
5. **Conectar la cámara** a la red del ESP32 (la cámara se reconfigura desde la app Tapo al nuevo WiFi).
6. **Verificar**: `cp puente.env.ejemplo puente.env`, completa usuario y clave,
   `chmod 600 puente.env` y ejecuta `sudo bash verificar_puente.sh`.
7. **Medir**: `bash medir_rendimiento.sh 60` con `stream2` y después con `RTSP_RUTA=stream1`.

## Riesgos conocidos

- **Rendimiento del ESP32 con WireGuard (el más incierto).** El proyecto cita 5 a 15 Mbit/s para NAT
  puro y no publica cifras con WireGuard activo. Hay que medirlo; `stream2` es lo realista, `stream1`
  solo si `medir_rendimiento.sh` lo aprueba.
- **No está confirmado en la documentación** que el ESP32 reenvíe tráfico general del túnel hacia
  `192.168.4.x`. Por eso el diseño no depende de eso: usa `portmap … VPN`, que sí está documentado.
- **Radio compartida.** AP y STA usan el mismo canal 2.4 GHz y se reparten el ancho de banda.
  Fija el canal del router de casa en vez de "Auto".
- **ONVIF a través de NAT.** La cámara responde con direcciones internas (`XAddr`). El cliente del VPS
  debe ignorarlas y usar siempre `10.8.0.2:2020`; no esperar WS-Discovery.
- **Límite de clientes:** 8 en el AP; aquí hay uno.
- **Credenciales:** la clave de la cámara vive solo en `vps/puente.env` del servidor. `ffmpeg` recibe la
  URL como argumento, por lo que otro usuario local del VPS podría verla con `ps`; con un solo usuario es aceptable.
- **Subredes:** el instalador aborta si `10.8.0.0/24` o `192.168.4.0/24` chocan con una ruta del
  servidor (incluye las redes de Docker). Cambia con `WG_SUBRED` o `SUBRED_AP`.

## Estado de verificación

| Elemento | Estado |
|---|---|
| Sintaxis y shellcheck de los scripts | **Ejecutado** (`pruebas/prueba_estatica.sh`, 33 de 33) |
| Instalador en modo simulado (`wg` falso): `wg0.conf`, comando `set_vpn`, permisos, idempotencia | **Ejecutado** |
| Lector de `puente.env` (sin ejecutar contenido), codificación de la clave, ocultamiento en la salida | **Ejecutado** |
| `medir_rendimiento.sh` con `ffmpeg` y `ping` simulados (cálculo del caudal) | **Ejecutado** |
| `foto_camara.sh` sin cámara (falla con código 1, no imprime la clave) | **Ejecutado** |
| Sintaxis de los comandos del ESP32 | **Verificación estática**: tomada de la wiki oficial; hay dos sintaxis distintas para el nombre en `dhcp_reserve`, por eso no se usa |
| Claves WireGuard reales, handshake, cifrado | **Pendiente de hardware/VPS** |
| `portmap … VPN` alcanza a la cámara | **Pendiente de hardware** |
| Foto RTSP real, ONVIF real, caudal de `stream1` y `stream2` | **Pendiente de hardware** |
| Estabilidad en 24 h, reconexión tras cortes de WiFi o de luz | **Pendiente de hardware** |

Los pendientes y sus criterios de aprobación están en `PRUEBAS_HARDWARE.md`.
