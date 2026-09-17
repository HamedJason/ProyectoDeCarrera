/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Taller 5: Prueba de concepto reducida
 *
 * Nodo sensor sobre ESP32 DevKit.
 *
 * Cadena demostrada por este firmware:
 *   entrada fisica -> procesamiento local -> Wi-Fi -> POST HTTPS al backend
 *
 * Nota sobre la entrada fisica:
 * En esta etapa se utiliza un push button porque el contacto magnetico reed
 * todavia no esta disponible. Ambos son contactos secos, es decir, cierran o
 * abren un circuito sin entregar voltaje propio, por lo que el firmware no
 * requiere cambios cuando se sustituya el boton por el sensor reed definitivo.
 *
 * Librerias necesarias (Gestor de librerias de Arduino IDE):
 *   - ArduinoJson (Benoit Blanchon), version 7.x
 * WiFi.h y HTTPClient.h vienen incluidas con el core de ESP32.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ===================== Configuracion editable =====================

const char* WIFI_SSID     = "NOMBRE_DE_TU_RED";
const char* WIFI_PASSWORD = "PASSWORD_DE_TU_RED";

// URL del backend desplegado. Debe terminar sin diagonal final.
const char* BACKEND_BASE  = "https://privada.ochil.ddns.net";

// Token simple del dispositivo. No es el esquema de seguridad definitivo,
// solo evita que cualquier peticion anonima escriba en la base de datos
// durante la prueba de concepto.
const char* DEVICE_TOKEN  = "poc-token-demo";

// Identificacion logica del nodo dentro del modelo vivienda / zona / nodo / sensor
const char* VIVIENDA_ID = "casa-001";
const char* ZONA        = "entrada";
const char* NODO_ID     = "nodo-01";
const char* SENSOR_ID   = "sensor-puerta-01";
const char* VARIABLE    = "estado_puerta";
const char* UNIDAD      = "estado";   // 0 = cerrada, 1 = abierta

// ===================== Hardware =====================

const int PIN_SENSOR = 4;   // entrada fisica, con resistencia pull-up interna
const int PIN_LED    = 2;   // actuador de la PoC, sustituye a la sirena

// ===================== Parametros de procesamiento =====================

const unsigned long DEBOUNCE_MS       = 50;    // filtrado de rebote mecanico
const unsigned long INTERVALO_CMD_MS  = 2000;  // consulta de comando al backend
const unsigned long TIMEOUT_HTTP_MS   = 8000;
const int           MAX_REINTENTOS    = 3;
const int           CAPACIDAD_BUFFER  = 20;

// ===================== Estado interno =====================

int  lecturaEstable = HIGH;
int  lecturaPrevia  = HIGH;
unsigned long tUltimoCambio = 0;
unsigned long tUltimoComando = 0;
unsigned long contadorRegistro = 0;

// Contadores para el reporte de pruebas
unsigned long enviosExitosos = 0;
unsigned long enviosFallidos = 0;

// Buffer local de eventos que no pudieron enviarse.
// Demuestra en pequeno el requisito de no perder eventos ante falta de Internet.
struct EventoPendiente {
  unsigned long numeroRegistro;
  int           valor;
  unsigned long msDesdeBoot;
};

EventoPendiente bufferEventos[CAPACIDAD_BUFFER];
int eventosEnBuffer = 0;

/*
 * Cliente TLS.
 *
 * El backend se publica por HTTPS, por lo que HTTPClient necesita un cliente
 * seguro explicito. Si se pasa solo la URL, la conexion falla sin un mensaje
 * claro en muchas versiones del core de ESP32.
 *
 * setInsecure() acepta el certificado del servidor sin verificarlo contra una
 * autoridad certificadora. Es aceptable para la prueba de concepto porque el
 * trafico sigue viajando cifrado, pero no protege contra un servidor suplantado.
 * En el prototipo alfa se sustituye fijando el certificado raiz del proveedor.
 */
WiFiClientSecure clienteSeguro;

// ===================== Utilidades =====================

void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("[WiFi] Conectando a ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 15000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Conectado. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] No se pudo conectar. Se reintentara mas adelante.");
  }
}

void guardarEnBuffer(unsigned long numeroRegistro, int valor) {
  if (eventosEnBuffer >= CAPACIDAD_BUFFER) {
    Serial.println("[Buffer] Lleno. Se descarta el evento mas antiguo.");
    for (int i = 1; i < CAPACIDAD_BUFFER; i++) {
      bufferEventos[i - 1] = bufferEventos[i];
    }
    eventosEnBuffer = CAPACIDAD_BUFFER - 1;
  }
  bufferEventos[eventosEnBuffer].numeroRegistro = numeroRegistro;
  bufferEventos[eventosEnBuffer].valor          = valor;
  bufferEventos[eventosEnBuffer].msDesdeBoot    = millis();
  eventosEnBuffer++;
  Serial.print("[Buffer] Eventos pendientes: ");
  Serial.println(eventosEnBuffer);
}

/*
 * Envia una medicion al backend.
 * Devuelve true solamente si el backend respondio 201.
 * La marca de tiempo definitiva la asigna el backend, tal como permite la
 * actividad, porque el ESP32 no tiene reloj de tiempo real en esta etapa.
 */
bool enviarMedicion(unsigned long numeroRegistro, int valor, unsigned long msDesdeBoot, long &latenciaMs) {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(BACKEND_BASE) + "/mediciones";

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.begin(clienteSeguro, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);

  JsonDocument doc;
  doc["vivienda_id"]     = VIVIENDA_ID;
  doc["zona"]            = ZONA;
  doc["nodo_id"]         = NODO_ID;
  doc["sensor_id"]       = SENSOR_ID;
  doc["variable"]        = VARIABLE;
  doc["valor"]           = valor;
  doc["unidad"]          = UNIDAD;
  doc["numero_registro"] = numeroRegistro;
  doc["ms_desde_boot"]   = msDesdeBoot;

  String cuerpo;
  serializeJson(doc, cuerpo);

  unsigned long t0 = millis();
  int codigo = http.POST(cuerpo);
  latenciaMs = (long)(millis() - t0);

  String respuesta = http.getString();
  http.end();

  Serial.print("[POST /mediciones] registro=");
  Serial.print(numeroRegistro);
  Serial.print(" valor=");
  Serial.print(valor);
  Serial.print(" codigo=");
  Serial.print(codigo);
  Serial.print(" latencia=");
  Serial.print(latenciaMs);
  Serial.println(" ms");
  Serial.print("   respuesta: ");
  Serial.println(respuesta);

  return (codigo == 201);
}

void intentarVaciarBuffer() {
  if (eventosEnBuffer == 0 || WiFi.status() != WL_CONNECTED) return;

  Serial.println("[Buffer] Intentando sincronizar eventos pendientes.");
  int enviados = 0;

  for (int i = 0; i < eventosEnBuffer; i++) {
    long latencia = 0;
    bool ok = enviarMedicion(bufferEventos[i].numeroRegistro,
                             bufferEventos[i].valor,
                             bufferEventos[i].msDesdeBoot,
                             latencia);
    if (!ok) break;
    enviados++;
    enviosExitosos++;
  }

  if (enviados > 0) {
    for (int i = enviados; i < eventosEnBuffer; i++) {
      bufferEventos[i - enviados] = bufferEventos[i];
    }
    eventosEnBuffer -= enviados;
    Serial.print("[Buffer] Sincronizados: ");
    Serial.print(enviados);
    Serial.print(". Restantes: ");
    Serial.println(eventosEnBuffer);
  }
}

/*
 * Procesa un evento confirmado de la entrada fisica.
 * El valor se normaliza a 1 = abierta y 0 = cerrada, de modo que el backend
 * reciba siempre un dato numerico independiente del tipo de contacto usado.
 */
void procesarEvento(int lectura) {
  contadorRegistro++;
  int valor = (lectura == LOW) ? 1 : 0;   // pull-up: LOW significa contacto cerrado

  Serial.print("[Evento] registro=");
  Serial.print(contadorRegistro);
  Serial.print(" estado=");
  Serial.println(valor == 1 ? "ABIERTA" : "CERRADA");

  bool enviado = false;
  long latencia = 0;

  for (int intento = 1; intento <= MAX_REINTENTOS && !enviado; intento++) {
    if (intento > 1) {
      Serial.print("[Reintento ");
      Serial.print(intento);
      Serial.println("]");
      delay(500);
    }
    enviado = enviarMedicion(contadorRegistro, valor, millis(), latencia);
  }

  if (enviado) {
    enviosExitosos++;
  } else {
    enviosFallidos++;
    guardarEnBuffer(contadorRegistro, valor);
  }

  Serial.print("[Contadores] exitosos=");
  Serial.print(enviosExitosos);
  Serial.print(" fallidos=");
  Serial.println(enviosFallidos);
}

/*
 * Consulta el estado del actuador en el backend.
 * Se usa polling porque en la prueba de concepto el transporte es HTTPS y no
 * existe un canal persistente hacia el dispositivo. Esta decision se sustituye
 * por MQTT en el prototipo alfa.
 */
void consultarComando() {
  if (WiFi.status() != WL_CONNECTED) return;

  String url = String(BACKEND_BASE) + "/comando?vivienda_id=" + VIVIENDA_ID;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.begin(clienteSeguro, url);
  int codigo = http.GET();

  if (codigo == 200) {
    String cuerpo = http.getString();
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, cuerpo);
    if (!err) {
      bool actuadorActivo = doc["actuador_activo"] | false;
      digitalWrite(PIN_LED, actuadorActivo ? HIGH : LOW);
    }
  }
  http.end();
}

// ===================== setup / loop =====================

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(PIN_SENSOR, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  lecturaEstable = digitalRead(PIN_SENSOR);
  lecturaPrevia  = lecturaEstable;

  // Acepta el certificado TLS sin verificarlo. Ver la nota junto a clienteSeguro.
  clienteSeguro.setInsecure();

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Nodo sensor - Prueba de concepto");
  Serial.print(" Vivienda: "); Serial.println(VIVIENDA_ID);
  Serial.print(" Zona:     "); Serial.println(ZONA);
  Serial.print(" Nodo:     "); Serial.println(NODO_ID);
  Serial.println("==========================================");

  conectarWiFi();
}

void loop() {
  // --- Lectura con filtrado de rebote (procesamiento basico del dato) ---
  int lectura = digitalRead(PIN_SENSOR);

  if (lectura != lecturaPrevia) {
    tUltimoCambio = millis();
    lecturaPrevia = lectura;
  }

  if ((millis() - tUltimoCambio) > DEBOUNCE_MS && lectura != lecturaEstable) {
    lecturaEstable = lectura;
    procesarEvento(lecturaEstable);
  }

  // --- Reconexion y sincronizacion de pendientes ---
  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
  } else {
    intentarVaciarBuffer();
  }

  // --- Consulta periodica del comando del actuador ---
  if (millis() - tUltimoComando > INTERVALO_CMD_MS) {
    tUltimoComando = millis();
    consultarComando();
  }

  delay(10);
}
