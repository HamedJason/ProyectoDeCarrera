# Evidencias que faltan por anexar al Taller 5

Solo se pueden obtener con el prototipo y el servidor reales. Cada una corresponde a un anexo de la sección 13.

| Anexo | Qué capturar | Cómo |
|---|---|---|
| A. Backend desplegado | Respuesta del endpoint de salud | En el navegador abre `https://sentinelhome.ddns.net/salud` (o `curl -s http://sentinelhome.ddns.net:8080/salud`) y toma captura. Debe verse `ok: true` y la base de datos conectada |
| B. Montaje | Fotografía del nodo C3 con los sensores y del hub | Foto clara de ambas placas con los cables a la vista |
| E. Monitor serie | Hub recibiendo eventos | Arduino IDE, monitor serie a 115200. Abre y cierra el contacto y pasa frente al PIR. Captura las líneas `[ESP-NOW] evento de ...` y `[POST] ... codigo=201` |
| F. Aplicación | Sensores e historial con datos reales | Captura de pantalla de la app en el teléfono con la lista de sensores y el historial |
| G. Notificación | Aviso push recibido | Con la casa armada, abre el contacto y captura la notificación en el teléfono |
| H. Script de pruebas | Resultado de `pruebas/medir_tiempos.js` | Ver abajo |

## Anexo H: ejecutar el script

Desde cualquier computadora con Node 18 o superior y la carpeta `pruebas` del repositorio:

```
node pruebas/medir_tiempos.js --url http://sentinelhome.ddns.net:8080 --token TU_TOKEN --vivienda casa-001
```

- Con el token global antiguo (el `DEVICE_TOKEN` del `.env`) hay que dar `--vivienda casa-001`. Con un token `hv_...` no.
- Para medir también el tiempo hasta el frontend agrega `--email tu@correo.com --clave "tu contraseña"` (hace falta tener cuenta en la app).
- El script imprime las tablas ya formateadas: copia la salida completa como Anexo H.
- Las mediciones de prueba quedan con el sensor `prueba-medicion`; se pueden eliminar desde la app.

Cuando tengas la salida y las capturas, mándalas y se actualiza el documento (el estado Parcial de la matriz pasa a Cumple).
