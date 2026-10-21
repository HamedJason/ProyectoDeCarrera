# Pruebas que requieren hardware (pendientes)

Cada prueba indica cómo ejecutarla y qué resultado la aprueba. Anota la fecha y el resultado en
`pruebas/EVIDENCIAS.md` del repositorio.

| # | Prueba | Cómo | Aprueba si |
|---|---|---|---|
| H1 | Identificar la placa | `esptool.py flash_id` (y `chip_id`) | Reporta ESP32-S3 y el tamaño de flash; anotar si hay PSRAM. |
| H2 | Arranque del firmware | Flashear, abrir consola serie a 115200, `show status` | La consola responde y el AP aparece. |
| H3 | Uplink | `set_sta …`, `restart`, `show status` | El ESP32 obtiene IP del router de casa. |
| H4 | Cámara en el AP | Reconectar la MC210 a `<SSID_PUENTE>` desde la app Tapo | `show status` la lista con `192.168.4.2` (reserva DHCP). |
| H5 | Túnel | Pegar el `set_vpn` del VPS; en el VPS `sudo wg show` | Handshake de menos de 3 min y `show vpn` del ESP32 en "Connected". |
| H6 | Puertos | `portmap add … VPN` (554 y 2020); `bash verificar_puente.sh` | Pasan "TCP abierto" en 554 y 2020. |
| H7 | ONVIF | `verificar_puente.sh` | Pasa "ONVIF responde". |
| H8 | RTSP | `verificar_puente.sh` | Pasa "RTSP stream2" con códec y resolución. |
| H9 | Foto de alarma | `bash foto_camara.sh prueba.jpg` 10 veces seguidas | 10/10 JPEG válidos, cada uno en menos de 10 s. |
| H10 | Caudal `stream2` | `bash medir_rendimiento.sh 60` en reposo y con movimiento | Pérdida de ping < 2 %, 0 líneas de error, caudal ≥ 90 % del anunciado. |
| H11 | Caudal `stream1` | `RTSP_RUTA=stream1 bash medir_rendimiento.sh 60` | Mismos criterios; si falla, se queda `stream2` (resultado válido, no un error del proyecto). |
| H12 | Ruta general hacia `192.168.4.x` | Desde el VPS: `ping 192.168.4.2` | **Informativa**: documenta si el ESP32 reenvía tráfico general del túnel. El diseño no depende de esto. |
| H13 | Corte del WiFi de casa | Apagar el router 2 min y encenderlo | El túnel se restablece solo en menos de 3 min; `verificar_puente.sh` vuelve a pasar. |
| H14 | Corte de luz del ESP32 | Desconectar y reconectar la alimentación | Vuelve con la misma configuración (NVS) y el túnel sube solo. |
| H15 | Estabilidad 24 h | `watch` o cron cada 5 min con `verificar_puente.sh`, registrar resultados | ≥ 99 % de las comprobaciones pasan; sin reinicios inesperados del ESP32. |
| H16 | Subredes en el VPS con Docker | Ejecutar `instalar_wireguard.sh` en el VPS real | No aborta; o aborta con un mensaje claro si hay choque. |

Si H10 o H11 fallan por rendimiento, las opciones son bajar la calidad en la app Tapo, cambiar
`-M` (MTU) o evaluar un fork con otro tamaño de búfer. Esa decisión se toma con los números medidos.
