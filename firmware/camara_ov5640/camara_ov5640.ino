/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Camara ESP32-S3 con sensor OV5640
 *
 * Esta placa NO participa en la logica de la alarma. La alarma suena y avisa
 * aunque la camara este apagada o desconectada (RF-15). La camara es un
 * complemento: cuando la alarma se dispara, el servidor le pide una rafaga de
 * fotos para tener evidencia, y el residente puede pedir una foto o la vista en
 * vivo desde la aplicacion.
 *
 *   alarma / aplicacion --> servidor --(la camara pregunta)--> ESP32 CAM
 *
 * COMO SE COMUNICA
 *   La camara esta detras del router de la casa, asi que el servidor no puede
 *   llamarla. Ella pregunta con una peticion larga:
 *        GET /camara/tarea?camara_id=...&espera=20
 *   El servidor la deja abierta hasta 20 s y la contesta en el instante en que
 *   aparece una tarea. En reposo cuesta una peticion cada 20 s (casi nada de
 *   datos); con una alarma, la camara se entera en milisegundos. No necesita
 *   ESP-NOW ni conocer al concentrador.
 *
 * TAREAS
 *   foto  rafaga de N fotos -> POST /camara/foto?tarea=ID  (JPEG crudo)
 *   vivo  sesion de vista en vivo -> POST /camara/cuadro?tarea=ID por cada
 *         cuadro, hasta que el servidor responde continuar=false
 *
 * AHORRO DE ANCHO DE BANDA Y DISCO (el VPS es el recurso mas escaso)
 *   - Las fotos son JPEG de ~100-300 KB. No se graba video.
 *   - La vista en vivo usa una resolucion menor (VGA por omision, ~1.6 Mbit/s)
 *     y el servidor solo retransmite el ultimo cuadro, sin guardarlo.
 *   - El servidor limita la duracion de cada sesion y los minutos por dia.
 *
 * LIBRERIAS (Gestor de librerias del Arduino IDE)
 *   - ArduinoJson (Benoit Blanchon), version 7.x
 *   El controlador de camara (esp_camera.h) viene con el core "esp32" de Espressif
 *   y ya soporta el OV5640.
 *
 * AJUSTES EN ARDUINO IDE
 *   - Placa:  "ESP32S3 Dev Module" (o la de tu fabricante)
 *   - PSRAM:  "OPI PSRAM" u "Enabled", segun tu modulo. SIN PSRAM no hay
 *             memoria para fotos grandes y el programa lo avisa y se detiene.
 *   - Flash:  la de tu modulo (8 o 16 MB) ; Partition Scheme: "Default".
 *
 * ENFOQUE
 *   El OV5640 tiene autoenfoque, pero depende del modulo y requiere cargarle
 *   un firmware interno que este programa NO carga. Trata la lente como de
 *   enfoque manual: muchos modulos permiten girarla. Ajustala una vez mirando
 *   la vista en vivo a la distancia a la que estara el area vigilada.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include "raiz_tls.h"
#include <ArduinoJson.h>
#include "esp_camera.h"

// ===================== Configuracion editable =====================

const char* WIFI_SSID     = "NOMBRE_DE_TU_RED";
const char* WIFI_PASSWORD = "PASSWORD_DE_TU_RED";

// URL del backend, sin diagonal final. Igual que en el concentrador.
const char* BACKEND_BASE  = "http://privadaochil.ddns.net:8080";

// El MISMO token de la vivienda que usa el concentrador (empieza con "hv_").
// Se genera en la app: Ajustes > Vivienda > Administrar > Dispositivos.
const char* DEVICE_TOKEN  = "PEGA_AQUI_EL_TOKEN_hv_...";

// Nombre de esta camara. Con varias camaras en la misma vivienda, que cada una
// tenga el suyo.
const char* CAMARA_ID = "camara-1";

// ----- Placa: deja descomentada SOLO la tuya -----
// Las asignaciones de pines las publica cada fabricante y varian entre
// revisiones de una misma placa. Verifica la tuya contra su hoja de datos antes
// de energizar. Si no coincide ninguna, usa BOARD_PERSONALIZADA y llena los pines.
#define BOARD_XIAO_ESP32S3_SENSE
// #define BOARD_ESP32S3_EYE_FREENOVE
// #define BOARD_AI_THINKER
// #define BOARD_PERSONALIZADA

// ----- Imagen -----
// Fotos de evidencia: FRAMESIZE_SXGA (1280x1024) da ~150 KB. FRAMESIZE_FHD
// (1920x1080) da mas detalle pero ~300-500 KB. El servidor rechaza mas de 1 MB.
const framesize_t TAMANO_FOTO = FRAMESIZE_SXGA;
const int CALIDAD_FOTO = 12;        // 10 (mejor) a 63 (peor)

// Vista en vivo: QVGA/VGA mantienen bajo el uso de banda del servidor.
const framesize_t TAMANO_VIVO = FRAMESIZE_VGA;
const int CALIDAD_VIVO = 16;
const unsigned long VIVO_INTERVALO_MIN_MS = 150;   // ~6 cuadros por segundo como maximo

const bool VOLTEAR_VERTICAL = true;      // pon true si la imagen sale de cabeza
const bool ESPEJO_HORIZONTAL = false;

// Ajuste fino del sensor. Son los valores que mejor se vieron probando con el
// ejemplo CameraWebServer de ESP32. Los de nitidez, ruido y ganancia son
// aproximados; si abres http://IP-de-la-camara/status en esa pagina de prueba
// puedes leer los numeros exactos y corregirlos aqui.
const int XCLK_MHZ = 10;               // 10 MHz da menos ruido y calienta menos que 20
const int AJ_BRILLO = 0;               // -3 a 3
const int AJ_CONTRASTE = 0;            // -3 a 3
const int AJ_SATURACION = 0;           // -4 a 4
const int AJ_NITIDEZ = 0;              // -3 a 3
const int AJ_REDUCCION_RUIDO = 4;      // 0 = automatico, hasta 8
const int AJ_EXPOSICION = 0;           // -5 a 5, nivel de exposicion automatica
const int AJ_GANANCIA_MAX = 225;       // tope de ganancia, 0 a 511

// LED o flash. -1 si no hay. Se enciende solo durante una foto de alarma.
const int PIN_FLASH = -1;

// ===================== Parametros de red =====================

const unsigned long ESPERA_TAREA_S = 20;              // espera del servidor (maximo 25)
const unsigned long TIMEOUT_TAREA_MS = 30000;         // debe ser mayor que la espera
const unsigned long TIMEOUT_SUBIDA_MS = 15000;
const unsigned long REINICIO_SIN_WIFI_MS = 600000;    // reinicia si pasa 10 min sin Wi-Fi
const int CUADROS_DESCARTADOS = 2;                    // deja que la exposicion se ajuste

// ===================== Pines segun la placa =====================

#if defined(BOARD_XIAO_ESP32S3_SENSE)
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  10
  #define SIOD_GPIO_NUM  40
  #define SIOC_GPIO_NUM  39
  #define Y9_GPIO_NUM    48
  #define Y8_GPIO_NUM    11
  #define Y7_GPIO_NUM    12
  #define Y6_GPIO_NUM    14
  #define Y5_GPIO_NUM    16
  #define Y4_GPIO_NUM    18
  #define Y3_GPIO_NUM    17
  #define Y2_GPIO_NUM    15
  #define VSYNC_GPIO_NUM 38
  #define HREF_GPIO_NUM  47
  #define PCLK_GPIO_NUM  13
#elif defined(BOARD_ESP32S3_EYE_FREENOVE)
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  15
  #define SIOD_GPIO_NUM  4
  #define SIOC_GPIO_NUM  5
  #define Y9_GPIO_NUM    16
  #define Y8_GPIO_NUM    17
  #define Y7_GPIO_NUM    18
  #define Y6_GPIO_NUM    12
  #define Y5_GPIO_NUM    10
  #define Y4_GPIO_NUM    8
  #define Y3_GPIO_NUM    9
  #define Y2_GPIO_NUM    11
  #define VSYNC_GPIO_NUM 6
  #define HREF_GPIO_NUM  7
  #define PCLK_GPIO_NUM  13
#elif defined(BOARD_AI_THINKER)
  // ESP32 clasico con PSRAM. Soporta el OV5640 pero rinde menos que un S3.
  #define PWDN_GPIO_NUM  32
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  0
  #define SIOD_GPIO_NUM  26
  #define SIOC_GPIO_NUM  27
  #define Y9_GPIO_NUM    35
  #define Y8_GPIO_NUM    34
  #define Y7_GPIO_NUM    39
  #define Y6_GPIO_NUM    36
  #define Y5_GPIO_NUM    21
  #define Y4_GPIO_NUM    19
  #define Y3_GPIO_NUM    18
  #define Y2_GPIO_NUM    5
  #define VSYNC_GPIO_NUM 25
  #define HREF_GPIO_NUM  23
  #define PCLK_GPIO_NUM  22
#elif defined(BOARD_PERSONALIZADA)
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  -1   // <- llena con los pines de tu placa
  #define SIOD_GPIO_NUM  -1
  #define SIOC_GPIO_NUM  -1
  #define Y9_GPIO_NUM    -1
  #define Y8_GPIO_NUM    -1
  #define Y7_GPIO_NUM    -1
  #define Y6_GPIO_NUM    -1
  #define Y5_GPIO_NUM    -1
  #define Y4_GPIO_NUM    -1
  #define Y3_GPIO_NUM    -1
  #define Y2_GPIO_NUM    -1
  #define VSYNC_GPIO_NUM -1
  #define HREF_GPIO_NUM  -1
  #define PCLK_GPIO_NUM  -1
#else
  #error "Descomenta una placa en la seccion de configuracion."
#endif

// ===================== Estado =====================

WiFiClient clienteRed;

// ===================== HTTPS opcional =====================
/*
 * Por omision el firmware habla HTTP plano con el puerto alterno del servidor.
 * Con USAR_HTTPS = true usa HTTPS contra el dominio que ya tiene certificado, y
 * BACKEND_BASE debe empezar con "https://" (sin puerto alterno). El token del
 * dispositivo deja de viajar en claro y se valida la identidad del servidor con
 * las raices de raiz_tls.h.
 *
 * Costos a tener en cuenta:
 *   - El ESP32 no tiene reloj: necesita la hora (NTP) para validar el
 *     certificado, asi que no envia nada hasta obtenerla. La alarma local no
 *     depende de esto.
 *   - El primer envio tras conectar tarda 1-3 s por el saludo TLS; los
 *     siguientes reutilizan la conexion.
 * HTTPS_SIN_VERIFICAR cifra pero NO comprueba al servidor. Solo para diagnostico.
 */
const bool USAR_HTTPS = false;
const bool HTTPS_SIN_VERIFICAR = false;

WiFiClientSecure clienteTls;
bool tlsConfigurado = false;

bool hayHora() { return time(nullptr) > 1700000000; }
bool redLista() { return WiFi.status() == WL_CONNECTED && (!USAR_HTTPS || hayHora()); }
void sincronizarHora() { if (USAR_HTTPS) configTime(0, 0, "pool.ntp.org", "time.google.com"); }
WiFiClient& clienteBackend() {
  if (!USAR_HTTPS) return clienteRed;
  if (!tlsConfigurado) {
    if (HTTPS_SIN_VERIFICAR) clienteTls.setInsecure(); else clienteTls.setCACert(RAIZ_TLS);
    tlsConfigurado = true;
  }
  return clienteTls;
}

bool camaraLista = false;
unsigned long tSinWiFi = 0;
int fallosConsecutivos = 0;
framesize_t tamanoActual = FRAMESIZE_INVALID;

// ===================== Camara =====================

// Aplica los ajustes de imagen del sensor (exposicion, balance de blancos, etc.).
void aplicarAjustesSensor(sensor_t* s) {
  s->set_brightness(s, AJ_BRILLO);
  s->set_contrast(s, AJ_CONTRASTE);
  s->set_saturation(s, AJ_SATURACION);
  s->set_sharpness(s, AJ_NITIDEZ);
  s->set_denoise(s, AJ_REDUCCION_RUIDO);
  s->set_ae_level(s, AJ_EXPOSICION);
  s->set_gainceiling(s, (gainceiling_t)AJ_GANANCIA_MAX);
  s->set_whitebal(s, 1);        // balance de blancos automatico
  s->set_awb_gain(s, 1);
  s->set_exposure_ctrl(s, 1);   // exposicion automatica
  s->set_aec2(s, 0);            // modo nocturno apagado
  s->set_gain_ctrl(s, 1);
  s->set_raw_gma(s, 1);
  s->set_lenc(s, 1);            // correccion de lente
  s->set_bpc(s, 1);
  s->set_wpc(s, 1);
  s->set_colorbar(s, 0);
}

bool iniciarCamara() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = XCLK_MHZ * 1000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = TAMANO_FOTO;
  c.jpeg_quality = CALIDAD_FOTO;
  c.fb_count = 2;                       // doble buffer: captura mientras se envia
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;     // siempre el cuadro mas reciente, no uno viejo

  if (!psramFound()) {
    Serial.println("[Camara] Esta placa no tiene PSRAM habilitada. Activala en Herramientas > PSRAM.");
    return false;
  }

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[Camara] Fallo al iniciar (0x%x). Revisa pines y el cable de la camara.\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (!s) return false;
  Serial.printf("[Camara] Sensor detectado, PID 0x%04x %s\n", s->id.PID,
                s->id.PID == OV5640_PID ? "(OV5640)" : "(no es un OV5640)");
  s->set_vflip(s, VOLTEAR_VERTICAL ? 1 : 0);
  s->set_hmirror(s, ESPEJO_HORIZONTAL ? 1 : 0);
  aplicarAjustesSensor(s);
  tamanoActual = TAMANO_FOTO;
  return true;
}

// Cambia resolucion y calidad, y descarta los primeros cuadros porque salen
// con la exposicion sin ajustar.
void usarPerfil(framesize_t tamano, int calidad) {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return;
  if (tamano != tamanoActual) {
    s->set_framesize(s, tamano);
    tamanoActual = tamano;
  }
  s->set_quality(s, calidad);
  for (int i = 0; i < CUADROS_DESCARTADOS; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }
}

// ===================== Red =====================

void atenderWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (tSinWiFi != 0) {
      Serial.print("[WiFi] Reconectado. IP: ");
      Serial.println(WiFi.localIP());
      sincronizarHora();
    }
    tSinWiFi = 0;
    return;
  }
  if (tSinWiFi == 0) {
    tSinWiFi = millis() ? millis() : 1;
    Serial.println("[WiFi] Sin conexion. Reintentando.");
  }
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Conectado. IP: ");
    Serial.println(WiFi.localIP());
    tSinWiFi = 0;
    sincronizarHora();
  } else if (millis() - tSinWiFi > REINICIO_SIN_WIFI_MS) {
    Serial.println("[WiFi] Demasiado tiempo sin red. Reiniciando.");
    ESP.restart();
  }
}

void prepararPeticion(HTTPClient& http, const String& ruta, unsigned long timeoutMs, const char* tipo) {
  http.setTimeout(timeoutMs);
  http.setReuse(true);
  http.begin(clienteBackend(), String(BACKEND_BASE) + ruta);
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  if (tipo) http.addHeader("Content-Type", tipo);
}

// Sube una imagen JPEG. Devuelve el codigo HTTP y, si hay, el cuerpo de la respuesta.
int subirImagen(const String& ruta, camera_fb_t* fb, String* respuesta) {
  HTTPClient http;
  prepararPeticion(http, ruta, TIMEOUT_SUBIDA_MS, "image/jpeg");
  int codigo = http.POST(fb->buf, fb->len);
  if (respuesta && codigo > 0) *respuesta = http.getString();
  http.end();
  return codigo;
}

// ===================== Tareas =====================

void tomarRafaga(long tareaId, int cantidad, int intervaloMs) {
  Serial.printf("[Foto] Tarea %ld: %d foto(s)\n", tareaId, cantidad);
  usarPerfil(TAMANO_FOTO, CALIDAD_FOTO);
  if (PIN_FLASH >= 0) digitalWrite(PIN_FLASH, HIGH);

  for (int i = 0; i < cantidad; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) { Serial.println("[Foto] No se pudo capturar."); break; }
    String ruta = "/camara/foto?tarea=" + String(tareaId) + "&camara_id=" + CAMARA_ID;
    unsigned long t0 = millis();
    int codigo = subirImagen(ruta, fb, nullptr);
    size_t bytes = fb->len;
    esp_camera_fb_return(fb);
    Serial.printf("[Foto] %d/%d  %u bytes  codigo=%d  %lu ms\n", i + 1, cantidad, (unsigned)bytes, codigo, millis() - t0);
    if (codigo != 201) break;   // 409 = la tarea ya termino; 507 = servidor sin espacio
    if (i + 1 < cantidad) delay(intervaloMs);
  }

  if (PIN_FLASH >= 0) digitalWrite(PIN_FLASH, LOW);
}

void transmitirVivo(long tareaId, int restanteS) {
  Serial.printf("[Vivo] Sesion %ld, hasta %d s\n", tareaId, restanteS);
  usarPerfil(TAMANO_VIVO, CALIDAD_VIVO);
  unsigned long inicio = millis();
  unsigned long tCuadro = 0;
  int fallos = 0;
  unsigned long cuadros = 0;

  while (WiFi.status() == WL_CONNECTED && (millis() - inicio) < (unsigned long)(restanteS + 5) * 1000UL) {
    unsigned long desde = millis() - tCuadro;
    if (desde < VIVO_INTERVALO_MIN_MS) delay(VIVO_INTERVALO_MIN_MS - desde);
    tCuadro = millis();

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) { if (++fallos >= 5) break; continue; }
    String respuesta;
    int codigo = subirImagen("/camara/cuadro?tarea=" + String(tareaId), fb, &respuesta);
    esp_camera_fb_return(fb);

    if (codigo != 200) {
      if (++fallos >= 5) { Serial.printf("[Vivo] Demasiados errores (ultimo %d). Se detiene.\n", codigo); break; }
      continue;
    }
    fallos = 0;
    cuadros++;
    JsonDocument doc;
    if (!deserializeJson(doc, respuesta) && !(doc["continuar"] | false)) break;
  }
  Serial.printf("[Vivo] Fin. Cuadros enviados: %lu en %lu s\n", cuadros, (millis() - inicio) / 1000);
}

// Pregunta si hay algo que hacer. Devuelve true si la consulta funciono.
bool consultarTarea() {
  HTTPClient http;
  String ruta = "/camara/tarea?camara_id=" + String(CAMARA_ID) + "&espera=" + String(ESPERA_TAREA_S);
  prepararPeticion(http, ruta, TIMEOUT_TAREA_MS, nullptr);
  int codigo = http.GET();

  if (codigo == 401 || codigo == 403) {
    Serial.println("[Tarea] Token rechazado. Revisa DEVICE_TOKEN.");
    http.end();
    return false;
  }
  if (codigo != 200) {
    Serial.printf("[Tarea] Error de consulta: %d\n", codigo);
    http.end();
    return false;
  }

  String cuerpo = http.getString();
  http.end();
  JsonDocument doc;
  if (deserializeJson(doc, cuerpo)) return false;
  if (doc["tarea"].isNull()) return true;   // nada que hacer, se vuelve a preguntar

  long id = doc["tarea"]["id"] | 0L;
  const char* tipo = doc["tarea"]["tipo"] | "";
  if (strcmp(tipo, "foto") == 0) {
    tomarRafaga(id, doc["tarea"]["restantes"] | 1, doc["tarea"]["intervalo_ms"] | 700);
  } else if (strcmp(tipo, "vivo") == 0) {
    transmitirVivo(id, doc["tarea"]["restante_s"] | 60);
  }
  return true;
}

// ===================== setup / loop =====================

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Camara OV5640 - Sistema de seguridad");
  Serial.print(" Camara: "); Serial.println(CAMARA_ID);
  Serial.println("==========================================");

  if (PIN_FLASH >= 0) { pinMode(PIN_FLASH, OUTPUT); digitalWrite(PIN_FLASH, LOW); }

  camaraLista = iniciarCamara();
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // menos latencia al recibir una tarea
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void loop() {
  if (!camaraLista) {
    // Sin camara no hay nada que ofrecer. Se reintenta por si fue un cable flojo.
    delay(10000);
    camaraLista = iniciarCamara();
    return;
  }

  atenderWiFi();
  if (!redLista()) { delay(500); return; }   // sin Wi-Fi, o sin hora para validar HTTPS

  if (consultarTarea()) {
    fallosConsecutivos = 0;
  } else {
    // Espera creciente (2 s a 30 s) para no insistir si el servidor esta caido
    fallosConsecutivos++;
    unsigned long espera = min(30000UL, 2000UL * (unsigned long)fallosConsecutivos);
    delay(espera);
  }
}
