// Camara ESP32-S3 con sensor OV5640. No participa en la logica de la alarma, que suena y avisa aunque la camara este
// apagada: cuando se dispara, el servidor le pide una rafaga de fotos como evidencia, y el residente puede pedir una
// foto o la vista en vivo desde la app.
//
// Como se comunica: esta detras del router y el servidor no puede llamarla, asi que ella pregunta con
//   GET /camara/tarea?camara_id=...&espera=20
// que el servidor deja abierta hasta 20 s y contesta en cuanto hay una tarea:
//   foto  rafaga de N fotos         -> POST /camara/foto?tarea=ID (JPEG crudo)
//   vivo  vista en vivo por cuadros -> POST /camara/cuadro?tarea=ID, hasta que el servidor responde continuar=false
// No se graba video y la vista en vivo usa resolucion baja para cuidar el VPS.
//
// Configuracion sin recompilar: Monitor Serie a 115200 con "Nueva linea"; todo queda en flash.
//   wifi NOMBRE_DE_LA_RED
//   clave PASSWORD
//   token hv_...         (el mismo de la vivienda que usa el concentrador)
//   servidor http://dominio:8080
//   camara camara-1      (nombre, distinto en cada camara de la vivienda)
// "ayuda" muestra el resto. Los comandos se leen entre una consulta y otra: con red pueden tardar hasta 20 s.
//
// Libreria: ArduinoJson (Benoit Blanchon) 7.x; esp_camera.h viene con el core.
// Arduino IDE: placa "ESP32S3 Dev Module", PSRAM "OPI PSRAM" o "Enabled" segun tu modulo (sin PSRAM no hay memoria
// para las fotos), Partition Scheme "Default".
// Enfoque: el autoenfoque del OV5640 requiere un firmware interno que este programa no carga; tratalo como enfoque
// manual y gira la lente una vez, mirando la vista en vivo a la distancia del area vigilada.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <time.h>
#include "raiz_tls.h"
#include <ArduinoJson.h>
#include "esp_camera.h"

const char* BACKEND_POR_DEFECTO = "http://privadaochil.ddns.net:8080";
const char* CAMARA_POR_DEFECTO  = "camara-1";

// Si es false, con https:// se cifra pero no se comprueba al servidor (solo diagnostico)
const bool HTTPS_VERIFICAR = true;

// Placa: deja descomentada SOLO la tuya. Los pines varian entre revisiones de
// una misma placa, verificalos con su hoja de datos antes de energizar. Si no
// coincide ninguna, usa BOARD_PERSONALIZADA y llena los pines.
#define BOARD_XIAO_ESP32S3_SENSE
// #define BOARD_ESP32S3_EYE_FREENOVE
// #define BOARD_AI_THINKER
// #define BOARD_PERSONALIZADA

// Fotos de evidencia: SXGA (1280x1024) da ~150 KB; FHD da mas detalle pero
// ~300-500 KB. El servidor rechaza mas de 1 MB.
const framesize_t TAMANO_FOTO = FRAMESIZE_SXGA;
const int CALIDAD_FOTO = 12;        // 10 (mejor) a 63 (peor)

// Vista en vivo: resolucion baja para no saturar al servidor
const framesize_t TAMANO_VIVO = FRAMESIZE_VGA;
const int CALIDAD_VIVO = 16;
const unsigned long VIVO_INTERVALO_MIN_MS = 150;   // ~6 cuadros por segundo como maximo

const bool VOLTEAR_VERTICAL = true;
const bool ESPEJO_HORIZONTAL = false;

// Ajuste fino del sensor, tomado de lo que mejor se vio en el ejemplo
// CameraWebServer. Nitidez, ruido y ganancia son aproximados.
const int XCLK_MHZ = 10;               // 10 MHz da menos ruido y calienta menos que 20
const int AJ_BRILLO = 0;               // -3 a 3
const int AJ_CONTRASTE = 0;            // -3 a 3
const int AJ_SATURACION = 0;           // -4 a 4
const int AJ_NITIDEZ = 0;              // -3 a 3
const int AJ_REDUCCION_RUIDO = 4;      // 0 = automatico, hasta 8
const int AJ_EXPOSICION = 0;           // -5 a 5
const int AJ_GANANCIA_MAX = 225;       // 0 a 511

const int PIN_FLASH = -1;   // LED de flash para las fotos de alarma (-1 si no hay)

const unsigned long ESPERA_TAREA_S = 20;              // espera del servidor (maximo 25)
const unsigned long TIMEOUT_TAREA_MS = 30000;         // debe ser mayor que la espera
const unsigned long TIMEOUT_SUBIDA_MS = 15000;
const unsigned long REINICIO_SIN_WIFI_MS = 600000;    // reinicia tras 10 min sin Wi-Fi
const int CUADROS_DESCARTADOS = 2;                    // deja que la exposicion se ajuste

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

Preferences prefs;
String cfgSsid, cfgClave, cfgToken, cfgServidor, cfgCamaraId;
String lineaSerie;

void cargarConfig() {
  prefs.begin("camara", false);
  cfgSsid     = prefs.getString("ssid", "");
  cfgClave    = prefs.getString("clave", "");
  cfgToken    = prefs.getString("token", "");
  cfgServidor = prefs.getString("servidor", BACKEND_POR_DEFECTO);
  cfgCamaraId = prefs.getString("camara", CAMARA_POR_DEFECTO);
}

// HTTP / HTTPS: el esquema de la URL del servidor decide si es http:// o https://

WiFiClient clienteRed;
WiFiClientSecure clienteTls;
bool tlsConfigurado = false;

bool usaHttps() { return cfgServidor.startsWith("https://"); }
bool hayHora() { return time(nullptr) > 1700000000; }
// Sin hora no se puede validar el certificado HTTPS
bool redLista() {
  return WiFi.status() == WL_CONNECTED && cfgToken.length() > 0 && (!usaHttps() || hayHora());
}
void sincronizarHora() { if (usaHttps()) configTime(0, 0, "pool.ntp.org", "time.google.com"); }

WiFiClient& clienteBackend() {
  if (!usaHttps()) return clienteRed;
  if (!tlsConfigurado) {
    if (HTTPS_VERIFICAR) clienteTls.setCACert(RAIZ_TLS); else clienteTls.setInsecure();
    tlsConfigurado = true;
  }
  return clienteTls;
}

bool camaraLista = false;
unsigned long tSinWiFi = 0;
int fallosConsecutivos = 0;
framesize_t tamanoActual = FRAMESIZE_INVALID;

void aplicarAjustesSensor(sensor_t* s) {
  s->set_brightness(s, AJ_BRILLO);
  s->set_contrast(s, AJ_CONTRASTE);
  s->set_saturation(s, AJ_SATURACION);
  s->set_sharpness(s, AJ_NITIDEZ);
  s->set_denoise(s, AJ_REDUCCION_RUIDO);
  s->set_ae_level(s, AJ_EXPOSICION);
  s->set_gainceiling(s, (gainceiling_t)AJ_GANANCIA_MAX);
  s->set_whitebal(s, 1);
  s->set_awb_gain(s, 1);
  s->set_exposure_ctrl(s, 1);
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
  c.grab_mode = CAMERA_GRAB_LATEST;     // siempre el cuadro mas reciente

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

// Cambia resolucion y calidad; los primeros cuadros salen con la exposicion
// sin ajustar, asi que se descartan.
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

void atenderWiFi() {
  if (cfgSsid.length() == 0) return;

  if (WiFi.status() == WL_CONNECTED) {
    if (tSinWiFi != 0) {
      Serial.print("[WiFi] Conectado. IP: ");
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
  WiFi.begin(cfgSsid.c_str(), cfgClave.length() ? cfgClave.c_str() : nullptr);
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
  http.begin(clienteBackend(), cfgServidor + ruta);
  http.addHeader("X-Device-Token", cfgToken);
  if (tipo) http.addHeader("Content-Type", tipo);
}

// Sube un JPEG. Devuelve el codigo HTTP y, si hay, el cuerpo de la respuesta.
int subirImagen(const String& ruta, camera_fb_t* fb, String* respuesta) {
  HTTPClient http;
  prepararPeticion(http, ruta, TIMEOUT_SUBIDA_MS, "image/jpeg");
  int codigo = http.POST(fb->buf, fb->len);
  if (respuesta && codigo > 0) *respuesta = http.getString();
  http.end();
  return codigo;
}

void tomarRafaga(long tareaId, int cantidad, int intervaloMs) {
  Serial.printf("[Foto] Tarea %ld: %d foto(s)\n", tareaId, cantidad);
  usarPerfil(TAMANO_FOTO, CALIDAD_FOTO);
  if (PIN_FLASH >= 0) digitalWrite(PIN_FLASH, HIGH);

  for (int i = 0; i < cantidad; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) { Serial.println("[Foto] No se pudo capturar."); break; }
    String ruta = "/camara/foto?tarea=" + String(tareaId) + "&camara_id=" + cfgCamaraId;
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
  String ruta = "/camara/tarea?camara_id=" + cfgCamaraId + "&espera=" + String(ESPERA_TAREA_S);
  prepararPeticion(http, ruta, TIMEOUT_TAREA_MS, nullptr);
  int codigo = http.GET();

  if (codigo == 401 || codigo == 403) {
    Serial.println("[Tarea] Token rechazado. Revisa el comando token.");
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

String enmascarar(const String& s, int visibles) {
  if (s.length() == 0) return "(vacio)";
  if ((int)s.length() <= visibles) return "****";
  return s.substring(0, visibles) + "...";
}

void mostrarConfig() {
  Serial.println("---------- Configuracion ----------");
  Serial.print("Red:        "); Serial.println(cfgSsid.length() ? cfgSsid : String("(sin configurar)"));
  Serial.print("Clave:      "); Serial.println(cfgClave.length() ? "****" : "(vacia)");
  Serial.print("Wi-Fi:      "); Serial.println(WiFi.status() == WL_CONNECTED ? "conectado" : "sin conexion");
  Serial.print("Servidor:   "); Serial.println(cfgServidor);
  Serial.print("Token:      "); Serial.println(enmascarar(cfgToken, 6));
  Serial.print("Camara:     "); Serial.println(cfgCamaraId);
  Serial.println("-----------------------------------");
}

void mostrarAyuda() {
  Serial.println("Comandos:");
  Serial.println("  wifi NOMBRE      nombre de la red Wi-Fi");
  Serial.println("  clave PASSWORD   clave de la red (sin valor = red abierta)");
  Serial.println("  conectar         reintenta la conexion con lo guardado");
  Serial.println("  token hv_...     token de la vivienda");
  Serial.println("  servidor URL     ej. http://dominio:8080 o https://dominio");
  Serial.println("  camara NOMBRE    nombre de esta camara");
  Serial.println("  ver              muestra la configuracion");
  Serial.println("  borrar           borra todo lo guardado y reinicia");
  Serial.println("  reiniciar");
}

void ejecutarComando(String linea) {
  linea.trim();
  if (linea.length() == 0) return;
  int esp = linea.indexOf(' ');
  String cmd = (esp < 0) ? linea : linea.substring(0, esp);
  String arg = (esp < 0) ? String("") : linea.substring(esp + 1);
  cmd.toLowerCase();
  arg.trim();

  if (cmd == "wifi") {
    if (arg.length() == 0) { Serial.println("Uso: wifi NOMBRE_DE_LA_RED"); return; }
    cfgSsid = arg;
    prefs.putString("ssid", cfgSsid);
    Serial.println("Red guardada. Ahora escribe: clave TU_PASSWORD");
  } else if (cmd == "clave") {
    cfgClave = arg;
    prefs.putString("clave", cfgClave);
    Serial.println("Clave guardada. Conectando.");
    WiFi.disconnect();
    tSinWiFi = 0;
  } else if (cmd == "conectar") {
    WiFi.disconnect();
    tSinWiFi = 0;
  } else if (cmd == "token") {
    if (arg.length() == 0) { Serial.println("Uso: token hv_..."); return; }
    cfgToken = arg;
    prefs.putString("token", cfgToken);
    Serial.println("Token guardado.");
  } else if (cmd == "servidor") {
    while (arg.endsWith("/")) arg.remove(arg.length() - 1);
    if (!arg.startsWith("http://") && !arg.startsWith("https://")) {
      Serial.println("Uso: servidor http://dominio:8080  (o https://dominio)");
      return;
    }
    cfgServidor = arg;
    prefs.putString("servidor", cfgServidor);
    Serial.print("Servidor guardado: ");
    Serial.println(cfgServidor);
    if (WiFi.status() == WL_CONNECTED) sincronizarHora();
  } else if (cmd == "camara") {
    if (arg.length() == 0) { Serial.println("Uso: camara NOMBRE"); return; }
    cfgCamaraId = arg;
    prefs.putString("camara", cfgCamaraId);
    Serial.println("Nombre guardado.");
  } else if (cmd == "ver") {
    mostrarConfig();
  } else if (cmd == "borrar") {
    prefs.clear();
    Serial.println("Todo borrado. Reiniciando.");
    delay(300);
    ESP.restart();
  } else if (cmd == "reiniciar") {
    ESP.restart();
  } else if (cmd == "ayuda" || cmd == "help" || cmd == "?") {
    mostrarAyuda();
  } else {
    Serial.println("Comando no reconocido. Escribe ayuda.");
  }
}

void atenderConsola() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      String l = lineaSerie;
      lineaSerie = "";
      ejecutarComando(l);
    } else if (lineaSerie.length() < 200) {
      lineaSerie += c;
    }
  }
}

// Recuerda lo que falta mientras la configuracion este incompleta
void avisarConfigIncompleta() {
  static unsigned long t = 0;
  if (millis() - t < 30000) return;
  t = millis();
  if (cfgSsid.length() == 0) Serial.println("[Config] Falta la red. Escribe: wifi NOMBRE y despues clave PASSWORD");
  else if (cfgToken.length() == 0) Serial.println("[Config] Falta el token. Escribe: token hv_...");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  cargarConfig();

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Camara OV5640 - Sistema de seguridad");
  Serial.println("==========================================");
  mostrarConfig();
  Serial.println("Escribe ayuda para ver los comandos.");

  if (PIN_FLASH >= 0) { pinMode(PIN_FLASH, OUTPUT); digitalWrite(PIN_FLASH, LOW); }

  camaraLista = iniciarCamara();
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // menos latencia al recibir una tarea
  if (cfgSsid.length() > 0) WiFi.begin(cfgSsid.c_str(), cfgClave.length() ? cfgClave.c_str() : nullptr);
}

void loop() {
  atenderConsola();

  if (!camaraLista) {
    // Sin camara no hay nada que ofrecer; se reintenta por si fue un cable flojo
    static unsigned long tReintento = 0;
    if (millis() - tReintento > 10000) {
      tReintento = millis();
      camaraLista = iniciarCamara();
    }
    delay(50);
    return;
  }

  atenderWiFi();
  avisarConfigIncompleta();
  if (!redLista()) { delay(200); return; }

  if (consultarTarea()) {
    fallosConsecutivos = 0;
  } else {
    // Espera creciente (2 s a 30 s) para no insistir si el servidor esta caido
    fallosConsecutivos++;
    unsigned long espera = min(30000UL, 2000UL * (unsigned long)fallosConsecutivos);
    delay(espera);
  }
}
