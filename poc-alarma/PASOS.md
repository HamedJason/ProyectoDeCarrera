# Guía de puesta en marcha

Despliegue en un VPS propio con Docker, desde una computadora con Windows.

**Regla de lectura:** cada bloque dice dónde se ejecuta.

- 🪟 **En tu PC (Windows)** — se escribe en PowerShell o en el Arduino IDE
- 🐧 **En el VPS (Linux)** — se escribe en la ventana de SSH, ya conectado al servidor

Casi todo ocurre en el VPS. Windows solo se usa para conectarse, hacer pruebas y
cargar el firmware.

Tiempo estimado: 45 a 60 minutos la primera vez.

---

## Antes de empezar

Ten a la mano:

- El usuario y la contraseña (o llave) de tu VPS
- El dominio: `privadaochil.ddns.net`
- La placa ESP32 y un cable USB que transmita datos, no solo carga

Un aviso sobre NO-IP: si tu cuenta es gratuita, el hostname se borra si no lo
confirmas cada 30 días. Si se borra a mitad del semestre, el ESP32 deja de
encontrar el servidor. Pon un recordatorio mensual.

---

## Paso 1 — Conectarte al VPS 🪟

Windows 10 y 11 ya traen SSH, no necesitas PuTTY.

Abre **PowerShell** (tecla Windows, escribe `powershell`, Enter) y ejecuta,
cambiando `usuario` por el tuyo:

```powershell
ssh usuario@privadaochil.ddns.net
```

La primera vez pregunta si confías en el servidor. Escribe `yes` y Enter.
Luego pide la contraseña. **Al escribirla no se ve nada, ni asteriscos.** Es
normal, escríbela completa y da Enter.

**Verificación:** el texto antes del cursor cambia a algo como
`usuario@servidor:~$`. A partir de aquí estás escribiendo en el VPS.

---

## Paso 2 — Revisar que el puerto esté libre 🐧

Este servidor ya tiene otro proyecto usando los puertos 80 y 443, por eso el
backend se publica en el **8080**. Confirma que ese puerto sí esté libre:

```bash
sudo ss -lntp | grep ':8080 '
```

**Dos resultados posibles:**

- **No imprime nada.** El puerto está libre. Continúa al paso 3.
- **Imprime una línea.** Está ocupado. Al final del paso 5 se explica cómo
  cambiar el número.

Confirma también que Docker responde:

```bash
docker ps
```

Debe mostrar una tabla, aunque esté vacía. Si dice "permission denied", antepón
`sudo` a todos los comandos de docker de esta guía.

---

## Paso 3 — Subir el código al VPS

### 3.1 Publicar en GitHub 🪟

El repositorio con README es un entregable de la actividad, así que esto sirve
para dos cosas a la vez.

Crea un repositorio vacío en <https://github.com/new>. No marques ninguna casilla
de inicialización. Luego, en PowerShell, dentro de la carpeta del proyecto:

```powershell
cd C:\ruta\donde\tengas\poc-alarma
git init
git add .
git commit -m "Prueba de concepto: firmware, backend y despliegue"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/poc-alarma.git
git push -u origin main
```

Si `git` no existe, instálalo desde <https://git-scm.com/download/win> y vuelve a
abrir PowerShell.

### 3.2 Clonar en el VPS 🐧

```bash
cd ~
git clone https://github.com/TU_USUARIO/poc-alarma.git
cd poc-alarma/deploy
```

**Verificación:**

```bash
ls
```

Debe listar `docker-compose.yml`, `.env.example` y `Caddyfile`, este último sin uso por ahora.

---

## Paso 4 — Configurar y levantar 🐧

Sigues dentro de `~/poc-alarma/deploy`.

```bash
cp .env.example .env
nano .env
```

Se abre un editor de texto. Cambia dos valores:

- `POSTGRES_PASSWORD` — pon una contraseña propia, sin espacios ni comillas
- `DEVICE_TOKEN` — invéntate uno, por ejemplo `alarma-uabc-2026`

Para guardar en nano: `Ctrl+O`, Enter, y luego `Ctrl+X` para salir.

Apunta el `DEVICE_TOKEN` que pusiste, lo necesitas en el firmware.

Ahora levanta todo:

```bash
docker compose up -d --build
```

La primera vez tarda entre 2 y 4 minutos porque descarga las imágenes y construye
el backend.

**Verificación:**

```bash
docker compose ps
```

Los dos servicios (`alarma_db` y `alarma_backend`) deben aparecer como `running`
o `Up`. Si alguno dice `Exited` o `Restarting`, revisa los registros del paso 5.

---

## Paso 5 — Comprobar que responde

### 5.1 Desde el propio VPS 🐧

```bash
curl http://localhost:8080/salud
```

Debe responder un JSON con `"estado":"ok"` y `"base_de_datos":"conectada"`.

Si no responde, revisa los registros:

```bash
docker compose logs backend --tail 30
docker compose logs db --tail 30
```

> **Nota sobre el puerto y HTTPS.** En este servidor los puertos 80 y 443 están
> ocupados por otro proyecto, por lo que el backend se publica en el **8080** por
> HTTP. Let's Encrypt valida los dominios a través del puerto 80, así que no es
> posible emitir un certificado mientras ese puerto esté en uso. El acceso sigue
> protegido por el token del dispositivo y la actividad no exige cifrado en esta
> etapa. Por eso las URL de aquí en adelante usan `http://` y el puerto `:8080`.

### 5.2 Desde Windows 🪟

Abre **otra** ventana de PowerShell, sin cerrar la del SSH.

> **Importante:** en PowerShell, `curl` no es el curl real, es un alias de otro
> comando y se comporta distinto. Escribe siempre **`curl.exe`** con la extensión.

```powershell
curl.exe http://privadaochil.ddns.net:8080/salud
```

Debe responder el mismo JSON, ahora desde fuera del servidor. Si funciona, el
backend ya es alcanzable por Internet.

**Toma captura de pantalla de esta respuesta.** Es la evidencia del backend
desplegado que pide la actividad.

### 5.3 Probar un dato válido y uno incorrecto 🐧

> **Estos dos comandos se ejecutan en la ventana del SSH, no en PowerShell.**
> PowerShell destroza las comillas dentro del JSON antes de que curl las reciba,
> y el resultado es un error de llaves sin cerrar. En Linux las comillas simples
> protegen el contenido tal cual, así que es mucho más simple hacerlo aquí. La
> evidencia vale igual: lo que se está probando es el backend, no el sistema
> operativo desde el que se le llama.

Cambia `TU_TOKEN` por el que pusiste en el `.env`.

Dato válido, debe responder **201**:

```bash
curl -s -w "\n--> HTTP %{http_code}\n" -X POST http://localhost:8080/mediciones \
  -H "Content-Type: application/json" \
  -H "X-Device-Token: TU_TOKEN" \
  -d '{"vivienda_id":"casa-001","zona":"entrada","nodo_id":"nodo-01","sensor_id":"sensor-puerta-01","variable":"estado_puerta","valor":1,"unidad":"estado","numero_registro":1}'
```

Dato incorrecto, debe responder **400** y enumerar los errores:

```bash
curl -s -w "\n--> HTTP %{http_code}\n" -X POST http://localhost:8080/mediciones \
  -H "Content-Type: application/json" \
  -H "X-Device-Token: TU_TOKEN" \
  -d '{"vivienda_id":"casa-001","nodo_id":"nodo-01","variable":"estado_puerta","valor":"abierto"}'
```

Guarda ambas salidas. Son la evidencia de la prueba de dato incorrecto.

#### Si de todos modos lo quieres correr desde Windows

Hay que anteponer `--%`, que le indica a PowerShell que deje de interpretar el
resto de la línea y lo pase tal cual al programa. Sin ese símbolo, las comillas
del JSON se pierden.

```powershell
curl.exe --% -X POST http://privadaochil.ddns.net:8080/mediciones -H "Content-Type: application/json" -H "X-Device-Token: TU_TOKEN" -d "{\"vivienda_id\":\"casa-001\",\"zona\":\"entrada\",\"nodo_id\":\"nodo-01\",\"sensor_id\":\"sensor-puerta-01\",\"variable\":\"estado_puerta\",\"valor\":1,\"unidad\":\"estado\",\"numero_registro\":1}"
```

### Si el puerto 8080 también estuviera ocupado

El contenedor `alarma_backend` no arrancará y los registros dirán
`port is already allocated`. Para ver qué lo tiene:

```bash
sudo ss -lntp | grep ':8080 '
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

La solución es elegir otro número. Edita el archivo:

```bash
nano docker-compose.yml
```

Busca la línea `- "8080:3000"` y cambia solo el número de la izquierda, por
ejemplo `- "8090:3000"`. Guarda con `Ctrl+O`, Enter, `Ctrl+X`, y levanta de nuevo:

```bash
docker compose up -d
```

Después ajusta ese mismo puerto en `BACKEND_BASE` del firmware.

### Si responde en el VPS pero no desde Windows

El backend funciona pero el puerto está cerrado hacia fuera. Dos lugares que
revisar:

```bash
sudo ufw status
```

Si aparece `Status: active`, abre el puerto:

```bash
sudo ufw allow 8080/tcp
```

Si tu proveedor de VPS tiene además un firewall propio en su panel web, abre ahí
el puerto 8080 también.

---

## Paso 6 — Cargar el firmware 🪟

### 6.1 Preparar el Arduino IDE

1. Instala el Arduino IDE desde <https://www.arduino.cc/en/software>
2. **Archivo → Preferencias**. En *Gestor de URLs adicionales de tarjetas* pega:

```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

3. **Herramientas → Placa → Gestor de tarjetas**. Busca `esp32`, instala el de
   Espressif. Tarda varios minutos.
4. **Herramientas → Gestionar librerías**. Busca `ArduinoJson` e instala la
   **versión 7**. Con la 6 no compila.

### 6.2 Configurar

Abre `firmware\nodo_sensor\nodo_sensor.ino` y edita estas cuatro líneas:

```cpp
const char* WIFI_SSID     = "nombre de tu red wifi";
const char* WIFI_PASSWORD = "password de tu wifi";
const char* BACKEND_BASE  = "http://privadaochil.ddns.net:8080";
const char* DEVICE_TOKEN  = "TU_TOKEN";
```

`BACKEND_BASE` va **sin diagonal al final**. El `DEVICE_TOKEN` debe ser idéntico
al del `.env` del VPS.

> El ESP32 solo se conecta a redes de 2.4 GHz. Si tu router tiene una red separada
> de 5 GHz, usa la de 2.4.

### 6.3 Conectar el botón

| ESP32 | Componente |
|---|---|
| GPIO 4 | una pata del push button |
| GND | la otra pata del push button |

No hace falta resistencia: el firmware activa la interna del microcontrolador.
El LED ya está integrado en la placa, no se cablea.

### 6.4 Cargar

1. Conecta el ESP32 por USB
2. **Herramientas → Placa → ESP32 Arduino → ESP32 Dev Module**
3. **Herramientas → Puerto**, elige el COM que aparezca
4. Botón de subir (la flecha)

**Verificación.** Abre **Herramientas → Monitor Serie** y pon **115200 baudios**
en la esquina. Debe verse la conexión Wi-Fi y su IP. Al presionar el botón:

```
[Evento] registro=1 estado=ABIERTA
[POST /mediciones] registro=1 valor=1 codigo=201 latencia=245 ms
```

Si el código es **201**, la cadena completa funciona de punta a punta.

---

## Paso 7 — Ejecutar las pruebas 🪟

1. **Diez transmisiones.** Presiona y suelta el botón diez veces, esperando unos
   segundos entre cada una. Del monitor serie anota para cada una: número de
   registro, código HTTP y latencia. Copia toda la salida a un archivo de texto.

2. **Dato incorrecto.** Ya lo hiciste en el paso 5.3, guarda esa salida.

3. **Pérdida de conexión.** Apaga el Wi-Fi del router. Presiona el botón tres
   veces. El monitor debe mostrar que los eventos van al buffer local. Vuelve a
   encender el Wi-Fi y verifica que se sincronizan solos.

4. **Conteo final.** Confirma que hay diez registros o más:

```powershell
curl.exe "http://privadaochil.ddns.net:8080/mediciones?vivienda_id=casa-001"
```

5. **Video.** Graba de 30 a 60 segundos mostrando: el botón presionándose, el
   monitor serie con el 201, y la consulta devolviendo el dato.

Mándame la salida del monitor serie y lleno las tablas del documento con tus
números reales.

---

---

## Conexión de los sensores definitivos

Reemplazan al push button provisional. Ambos son entradas digitales directas,
sin resistencias externas.

### Contacto magnético MC-38 (puerta o ventana)

| ESP32 | MC-38 |
|---|---|
| GPIO 4 | un cable (cualquiera de los dos) |
| GND | el otro cable |

El MC-38 es un contacto seco sin polaridad, así que no importa cuál cable va a
cada lado. El firmware activa la resistencia de elevación interna.

La parte con cable se atornilla al marco y el imán a la puerta, separados por
menos de 1 cm cuando está cerrada. Al abrirse el imán se aleja, el contacto se
abre y el ESP32 lo lee como apertura.

### Sensor de movimiento AM312

| ESP32 | AM312 |
|---|---|
| 3V3 | VCC |
| GPIO 5 | OUT |
| GND | GND |

El AM312 entrega 3.3 V en su salida, por lo que se conecta directo sin divisor.
No tiene potenciómetros de ajuste como el HC-SR501: su retardo es fijo de unos
2 segundos y su sensibilidad no se modifica. Por eso el firmware agrega un
bloqueo de 8 segundos entre eventos de movimiento, para no llenar el historial
mientras alguien permanece en la habitación.

Al encenderlo tarda entre 30 y 60 segundos en estabilizarse. Durante ese lapso
puede reportar movimiento sin causa real. Espera ese tiempo antes de medir
falsos positivos.

### Separar los sensores en un ESP32-C3 (ESP-NOW)

Arquitectura: el ESP32-C3 lee el MC-38 y el AM312 y manda cada evento por
ESP-NOW al ESP32 receptor, que sigue siendo el único conectado al Wi-Fi y al
backend y el que decide la alarma.

```
[MC-38 + AM312] -> ESP32-C3 --ESP-NOW--> ESP32 receptor --Wi-Fi--> backend
```

**Conexiones del C3** (pines editables en `firmware/nodo_c3/nodo_c3.ino`):

| Sensor | Pin del sensor | Pin del ESP32-C3 |
|---|---|---|
| MC-38 puerta | un cable | GPIO 4 |
| MC-38 puerta | otro cable | GND |
| MC-38 ventana | un cable | GPIO 3 |
| MC-38 ventana | otro cable | GND |
| AM312 | VCC | 3V3 (o 5V) |
| AM312 | VOUT | GPIO 5 |
| AM312 | GND | GND |

En el C3 evita los GPIO 2, 8 y 9 (arranque) y el 18 y 19 (USB).

**Puesta en marcha, en este orden:**

1. Carga `firmware/nodo_sensor/nodo_sensor.ino` en el ESP32 receptor (con tu Wi-Fi y `BACKEND_BASE`). Abre el monitor serie y copia la línea `[MAC] Esta placa (nodo receptor): AA:BB:...`.
2. En `firmware/nodo_c3/nodo_c3.ino` pon esa dirección en `MAC_RECEPTOR`, en formato `{ 0xAA, 0xBB, ... }`, y carga el sketch en el C3. Placa en el IDE: *ESP32C3 Dev Module* (activa *USB CDC On Boot* para ver el monitor serie).
3. El C3 imprime `[Enlace] Receptor encontrado en el canal N`. Si no aparece, revisa la MAC.
4. Espera 45 s a que el PIR se estabilice. El receptor mostrará `[ESP-NOW] evento de nodo-c3-01: ...` con cada apertura o movimiento.

El C3 busca solo el canal del receptor (el del router) y lo vuelve a buscar si cambia. Si el receptor está apagado, guarda hasta 16 eventos y los manda al volver.

**Más contactos (otra puerta o ventana).** En `nodo_c3.ino` añade una línea a la tabla `CONTACTOS` con un identificador único y un pin libre, por ejemplo `{ "sensor-ventana-02", "cocina", 6 }` (hasta 6 contactos). Recarga el C3 y el sensor aparece solo en la aplicación; ahí eliges si es puerta o ventana. El receptor admite hasta 8 sensores remotos.

Con los mismos `sensorId` (`sensor-puerta-01`, `pir-sala-01`) la aplicación conserva los nombres y el historial.
Si quieres que el receptor también lea sensores propios, pon `USAR_SENSORES_LOCALES = true`.

**Cifrado (opcional).** Pon `USAR_CIFRADO = true` en los dos sketches con las mismas claves de 16 caracteres, y en el receptor escribe la MAC del C3 en `MAC_C3` (la imprime el C3 al arrancar).

### Salida audible

Por ahora el GPIO 2 mueve el LED integrado. Para la bocina de 12 V hace falta el
relevador o el transistor que todavía no se adquiere, más su fuente
independiente. **No conectes la bocina directamente a un GPIO.**

Cuando tengas el relevador:

| ESP32 | Relevador |
|---|---|
| GPIO 2 | IN |
| 5V o VIN | VCC |
| GND | GND |

La bocina se alimenta de la fuente de 12 V, pasando por los contactos del
relevador. El ESP32 solo abre y cierra, nunca conduce los 12 V.

---

## Usar la aplicación

La aplicación se sirve desde el mismo backend. Abre en cualquier teléfono:

```
http://privadaochil.ddns.net:8080/
```

No requiere instalación. Para que quede con ícono propio y a pantalla completa,
en Android usa el menú del navegador y elige agregar a pantalla de inicio. En
iPhone usa el botón de compartir de Safari y elige añadir a la pantalla de
inicio.

Para ver otra vivienda, agrega el parámetro al final:

```
http://privadaochil.ddns.net:8080/?vivienda=casa-002
```

La vivienda se crea sola la primera vez que se consulta, sin ningún alta previa.

### Actualizar el despliegue tras estos cambios

```bash
cd ~/poc-alarma
git pull
cd deploy
docker compose up -d --build
```

Las tablas nuevas se crean solas al arrancar. Los eventos que ya tenías se
conservan.

## Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `curl` en PowerShell da error raro | `curl` es alias de otro comando | Usa `curl.exe` con extensión |
| `unmatched close brace/bracket` | PowerShell se comió las comillas del JSON | Haz el POST desde el SSH, o antepón `--%` a los argumentos |
| Responde una página HTML de 404 | La URL apunta a otro servicio | Revisa que sea `http://` y que lleve `:8080`. Con `https://` la petición va al puerto 443, donde está tu otro proyecto |
| PowerShell muestra `>>` y no ejecuta | La línea quedó incompleta por las comillas | `Ctrl+C` para salir, y vuelve a intentar |
| No compila, error en `JsonDocument` | ArduinoJson versión 6 | Instala la versión 7 |
| `codigo=-1` en el monitor | URL con diagonal final, o el certificado aún no se emite | Quita la diagonal, espera un minuto |
| `codigo=401` | El token del firmware no coincide con el del `.env` | Compara ambos carácter por carácter |
| `codigo=404` | `BACKEND_BASE` mal escrito | Revisa que sea exactamente el dominio |
| El ESP32 no aparece en Puerto | Falta driver USB, o el cable es solo de carga | Instala driver CP2102 o CH340, prueba otro cable |
| No conecta al Wi-Fi | Red de 5 GHz | Usa la red de 2.4 GHz |
| `port is already allocated` al levantar | El puerto 8080 está ocupado | Cambiarlo, ver el final del paso 5 |
| Responde en el VPS pero no desde Windows | Firewall cerrado | `sudo ufw allow 8080/tcp`, y revisar el panel del proveedor |
| `alarma_backend` reiniciándose | Contraseña de Postgres con caracteres raros | Usa solo letras y números en `.env` |

### Comandos útiles en el VPS 🐧

```bash
cd ~/poc-alarma/deploy

docker compose ps                    # estado de los servicios
docker compose logs -f backend       # ver registros en vivo (Ctrl+C para salir)
docker compose restart backend       # reiniciar solo el backend
docker compose down                  # detener todo
docker compose up -d --build         # levantar de nuevo tras cambiar código
```

Para actualizar el código después de un cambio:

```bash
cd ~/poc-alarma
git pull
cd deploy
docker compose up -d --build
```

## Cuentas, varias viviendas y camara

1. Redespliega el backend (`docker compose up -d --build`). El esquema se actualiza solo.
2. Abre la app y crea la primera cuenta: hereda `casa-001`. Despues el registro se cierra;
   para sumar personas usa Ajustes > Vivienda > Administrar > "Crear codigo de invitacion".
3. En Administrar > Dispositivos pulsa "Generar token nuevo" (empieza con `hv_`, se muestra
   una sola vez) y pegalo en `DEVICE_TOKEN` del concentrador y de la camara.
4. Sensores automaticos: el nodo C3 se identifica con su MAC (`c3-xxxxxx`). Al encenderlo
   aparece en la app con la etiqueta "Nuevo"; al ponerle nombre queda confirmado.
5. Camara (`firmware/camara_ov5640`): elige tu placa con `#define BOARD_...`, activa PSRAM,
   pon Wi-Fi, URL y el mismo token. Pregunta al servidor con una peticion larga de 20 s.
6. Buzzer: activo, entre GPIO 4 y GND (el LED integrado en GPIO 2 lo refleja).

Dimensionamiento del VPS (2 vCore, 4 GB, 40 GB NVMe, sin limite de trafico): el cuello
de botella es el disco, no la red. Por eso solo se guardan fotos (~100-300 KB), con tope de
14 dias, 300 MB por vivienda y 1.5 GB total; la vista en vivo (~1.6 Mbit/s) se limita a
5 min por sesion y 60 min por dia, y el servidor solo retransmite el ultimo cuadro.
