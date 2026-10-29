// Concentrador (ESP32 DevKit): la unica placa conectada al Wi-Fi y al backend. Recibe por ESP-NOW los eventos de los
// nodos C3 (nodo_c3.ino), decide si suena la sirena y avisa al servidor. La alarma funciona aunque no haya Internet.
//
// Configuracion sin recompilar: abre el Monitor Serie a 115200 con "Nueva linea" y escribe los comandos;
// todo queda en flash y sobrevive a reinicios:
//   wifi NOMBRE_DE_LA_RED
//   clave PASSWORD
//   token hv_...         (Ajustes > Vivienda > Administrar > Dispositivos)
//   servidor http://dominio:8080
//   emparejar            (abre 2 min para que los C3 se enlacen solos)
// "ayuda" muestra el resto. Libreria necesaria: ArduinoJson (Benoit Blanchon) 7.x

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <time.h>
#include "raiz_tls.h"
#include <ArduinoJson.h>
#include <esp_now.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <esp_idf_version.h>
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include <esp_mac.h>
#else
#include <esp_system.h>
#endif

// Valores por omision: se pueden cambiar por comando y solo se usan si no hay nada guardado.

const char* BACKEND_POR_DEFECTO  = "http://privadaochil.ddns.net:8080";
const char* VIVIENDA_POR_DEFECTO = "casa-001";   // solo cuenta con el token global antiguo
const char* NODO_ID = "hub-01";                  // nombre de este concentrador

// Si es true lee los sensores de las tablas de abajo ademas de los C3
const bool USAR_SENSORES_LOCALES = false;

// Si es true, el servidor valida el certificado HTTPS. Pon false solo para
// diagnostico: cifra pero no comprueba quien responde.
const bool HTTPS_VERIFICAR = true;

// Cifrado y firma de ESP-NOW; debe coincidir con nodo_c3.ino. La llave NO esta
// en el codigo: se carga por consola con el comando llave y vive en la flash.
// Si no hay llave guardada, el sistema funciona sin cifrar y lo avisa.
const bool USAR_CIFRADO = true;

// Sirena: buzzer activo o modulo relevador entre este pin y GND
const int PIN_SALIDA = 4;
const int PIN_LED_ESTADO = 2;

// Contactos MC-38: un cable al pin y otro a GND (pull-up interno).
// Pines recomendados: 4, 16, 17, 21, 22, 23. Evitar 0, 2, 5, 12, 15 y 34-39.
struct Contacto {
  const char* sensorId;
  const char* zona;
  int pin;
  int estable;             // lectura ya filtrada
  int previa;              // ultima lectura cruda
  unsigned long tCambio;
};

Contacto contactos[] = {
  { "sensor-puerta-01", "entrada", 4, HIGH, HIGH, 0 },
};
const int NUM_CONTACTOS = USAR_SENSORES_LOCALES ? (int)(sizeof(contactos) / sizeof(contactos[0])) : 0;

// Sensores de movimiento AM312. Pines recomendados: 18, 19, 25, 26, 27.
// El GPIO 5 no sirve: es de arranque y da lecturas falsas.
struct Pir {
  const char* sensorId;
  const char* zona;
  int pin;
  volatile bool pulso;     // lo levanta la interrupcion
  unsigned long tUltimo;   // ultimo evento aceptado
  int previa;
};

Pir pirs[] = {
  { "pir-sala-01", "sala", 18, false, 0 },
};
const int NUM_PIRS = USAR_SENSORES_LOCALES ? (int)(sizeof(pirs) / sizeof(pirs[0])) : 0;

// Protocolo ESP-NOW: igual que en nodo_c3.ino. Los tipos van antes de las funciones porque el Arduino IDE
// genera los prototipos al inicio del archivo.

const uint8_t TIPO_EVENTO    = 1;
const uint8_t TIPO_ESTADO    = 2;
const uint8_t TIPO_HOLA      = 3;   // prueba de canal
const uint8_t TIPO_EMPAREJAR = 4;   // el C3 pide enlazarse (broadcast)
const uint8_t TIPO_RESPUESTA = 5;   // el concentrador acepta (broadcast con la MAC del C3)
const uint8_t TIPO_ARMADO    = 6;   // el concentrador informa si la casa esta armada (valor 1/0)

struct __attribute__((packed)) PaqueteSensor {
  uint8_t  magia[2];
  uint8_t  version;
  uint8_t  tipo;
  uint32_t secuencia;
  char     nodoId[16];
  char     sensorId[24];
  char     variable[16];
  char     zona[16];
  int8_t   valor;
  uint8_t  tag[8];        // firma HMAC-SHA256 recortada
};

struct OrigenRemoto { uint8_t mac[6]; uint32_t ultimaSecuencia; bool usado; };
struct EstadoRemoto { char sensorId[24]; int valor; bool usado; };

const int MAX_NODOS = 6;
const int MAX_SENSORES_NODO = 6;
struct SensorVisto { char sensorId[24]; char variable[16]; char zona[16]; };
struct NodoVisto {
  bool usado;
  char nodoId[16];
  unsigned long ultimoMs;
  int rssi;
  int numSensores;
  SensorVisto sensores[MAX_SENSORES_NODO];
};

const uint8_t MAC_BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

Preferences prefs;

// Una sola llave de 16 bytes por instalacion, en flash y nunca en el codigo: de ella salen la PMK, la LMK de cada
// nodo y la llave de las firmas (HMAC-SHA256 recortada a 8 bytes). Sin llave funciona sin cifrar y lo avisa.
const size_t LARGO_TAG = 8;
uint8_t llaveMaestra[16];
uint8_t pmkDerivada[16];
uint8_t llaveFirma[32];
bool cifradoActivo = false;

void derivarLlave(const char* etiqueta, const uint8_t* extra, size_t nExtra, uint8_t* salida32) {
  uint8_t buf[40];
  size_t n = 16;
  memcpy(buf, llaveMaestra, 16);
  size_t l = strlen(etiqueta);
  memcpy(buf + n, etiqueta, l); n += l;
  if (extra && nExtra) { memcpy(buf + n, extra, nExtra); n += nExtra; }
  mbedtls_sha256(buf, n, salida32, 0);
}

// LMK de un nodo: depende de la llave y de la MAC de ese nodo
void lmkDeNodo(const uint8_t* macNodo, uint8_t* lmk16) {
  uint8_t h[32];
  derivarLlave("lmk", macNodo, 6, h);
  memcpy(lmk16, h, 16);
}

bool hmacPaquete(const PaqueteSensor* p, uint8_t* tag8) {
  uint8_t h[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (mbedtls_md_hmac(info, llaveFirma, 32, (const uint8_t*)p, sizeof(PaqueteSensor) - LARGO_TAG, h) != 0) return false;
  memcpy(tag8, h, LARGO_TAG);
  return true;
}

void firmarPaquete(PaqueteSensor* p) {
  memset(p->tag, 0, LARGO_TAG);
  if (!cifradoActivo) return;
  hmacPaquete(p, p->tag);
}

// Comparacion de tiempo constante
bool paqueteAutentico(const PaqueteSensor* p) {
  if (!cifradoActivo) return true;
  uint8_t esperado[8];
  if (!hmacPaquete(p, esperado)) return false;
  uint8_t d = 0;
  for (size_t i = 0; i < LARGO_TAG; i++) d |= esperado[i] ^ p->tag[i];
  return d == 0;
}

void cargarLlave() {
  cifradoActivo = false;
  if (!USAR_CIFRADO) {
    Serial.println("[Seguridad] Cifrado desactivado en el codigo (USAR_CIFRADO).");
    return;
  }
  if (prefs.getBytesLength("llave") != 16) {
    Serial.println("[Seguridad] AVISO: sin llave. Los paquetes van SIN cifrar ni firmar. Usa el comando llave.");
    return;
  }
  prefs.getBytes("llave", llaveMaestra, 16);
  uint8_t h[32];
  derivarLlave("pmk", nullptr, 0, h);
  memcpy(pmkDerivada, h, 16);
  derivarLlave("mac", nullptr, 0, llaveFirma);
  cifradoActivo = true;
  Serial.println("[Seguridad] Cifrado y firma de paquetes activos.");
}

int nibbleHex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool guardarLlaveHex(const String& hex) {
  if (hex.length() != 32) return false;
  uint8_t k[16];
  for (int i = 0; i < 16; i++) {
    int a = nibbleHex(hex[2 * i]), b = nibbleHex(hex[2 * i + 1]);
    if (a < 0 || b < 0) return false;
    k[i] = (uint8_t)(a * 16 + b);
  }
  prefs.putBytes("llave", k, 16);
  return true;
}

String llaveComoHex() {
  uint8_t k[16];
  if (prefs.getBytes("llave", k, 16) != 16) return String("");
  char t[33];
  for (int i = 0; i < 16; i++) snprintf(t + 2 * i, 3, "%02x", k[i]);
  return String(t);
}
String cfgSsid, cfgClave, cfgToken, cfgServidor, cfgVivienda;

// MACs de los C3 emparejados (se guardan en la flash)
const int MAX_PAREADOS = 6;   // tambien es el maximo de pares cifrados de ESP-NOW
uint8_t pareados[MAX_PAREADOS][6];
int numPareados = 0;

int indicePareado(const uint8_t* mac) {
  for (int i = 0; i < numPareados; i++) {
    if (memcmp(pareados[i], mac, 6) == 0) return i;
  }
  return -1;
}

bool macPermitida(const uint8_t* mac) {
  return indicePareado(mac) >= 0;
}

String macATexto(const uint8_t* mac) {
  char t[18];
  snprintf(t, sizeof(t), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(t);
}

void cargarConfig() {
  prefs.begin("seguridad", false);
  cfgSsid     = prefs.getString("ssid", "");
  cfgClave    = prefs.getString("clave", "");
  cfgToken    = prefs.getString("token", "");
  cfgServidor = prefs.getString("servidor", BACKEND_POR_DEFECTO);
  cfgVivienda = prefs.getString("vivienda", VIVIENDA_POR_DEFECTO);

  size_t bytes = prefs.getBytesLength("nodos");
  if (bytes > MAX_PAREADOS * 6) bytes = MAX_PAREADOS * 6;
  if (bytes >= 6) {
    prefs.getBytes("nodos", pareados, bytes);
    numPareados = bytes / 6;
  }
}

void guardarNodos() {
  if (numPareados == 0) prefs.remove("nodos");
  else prefs.putBytes("nodos", pareados, numPareados * 6);
}

const unsigned long DEBOUNCE_MS = 50;
const unsigned long BLOQUEO_PIR_MS = 8000;           // espera minima entre eventos de movimiento
const unsigned long PIR_ESTABILIZACION_MS = 45000;   // el AM312 tarda 30-60 s tras energizarse
const unsigned long INTERVALO_ESTADO_MS = 2000;
const unsigned long TIMEOUT_HTTP_MS = 5000;
const unsigned long INTERVALO_RECONEXION_MS = 10000;
const unsigned long DURACION_EMPAREJAR_MS = 120000;
const int  MAX_REINTENTOS   = 3;
const int  CAPACIDAD_BUFFER = 20;

const unsigned long DURACION_SIRENA_MS = 30000;   // tiempo maximo si nadie la apaga

// Con un LED o buzzer la salida parpadea; con sirena real en relevador, ponlo en false
const bool SALIDA_INTERMITENTE = true;
const unsigned long INTERVALO_PARPADEO_MS = 300;
const unsigned long INTERVALO_REPORTE_ALARMA_MS = 1000;

bool pirListo = false;

// El AM312 deja su salida en alto solo ~2 s, asi que el flanco se captura con
// interrupcion para no perderlo mientras el ciclo espera una peticion HTTP.
void IRAM_ATTR alDetectarPir(void* arg) {
  pirs[(int)(intptr_t)arg].pulso = true;
}

unsigned long tUltimoEstado = 0;
unsigned long contadorRegistro = 0;
unsigned long enviosExitosos = 0;
unsigned long enviosFallidos = 0;

bool sistemaArmado   = false;
bool armadoConocido  = false;   // ya se consulto el backend al menos una vez
bool modoSilencioso  = false;
bool salidaManual    = false;   // activacion directa desde la app

bool sirenaPorAlarma = false;
unsigned long tInicioSirena = 0;

// La alarma se decide localmente y despues se informa al backend
bool alarmaReportadaActiva = false;   // ultimo valor que el backend conoce
bool alarmaConfirmada = false;        // el backend ya la vio activa
char motivoAlarma[20] = "";
char zonaAlarma[20]   = "";
char sensorAlarma[24] = "";
char nodoAlarma[16]   = "";
unsigned long tUltimoReporteAlarma = 0;
unsigned long tDisparoAlarma = 0;     // para medir cuanto tarda en avisar

bool wifiEstabaConectado = false;
unsigned long tUltimoIntentoWiFi = 0;

// Emparejamiento: la ventana la abre el comando "emparejar"
volatile bool emparejando = false;
unsigned long tFinEmparejar = 0;
volatile bool nodoNuevo = false;     // la recepcion avisa al ciclo principal
volatile bool nodosLlenos = false;
char nombreNuevo[16] = "";
uint8_t macNueva[6];
volatile bool hayDesconocido = false;
uint8_t macDesconocida[6];

struct EventoPendiente {
  unsigned long numeroRegistro;
  char          variable[20];
  char          zona[20];
  char          sensorId[24];
  char          nodoId[16];
  int           valor;
};

EventoPendiente bufferEventos[CAPACIDAD_BUFFER];
int eventosEnBuffer = 0;

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

bool enviarAlarma(bool activa, bool silenciosa);
void sincronizarAlarma();
void iniciarEspNow();
void registrarPares();

// Wi-Fi no bloqueante: nunca detiene el ciclo; mientras espera la red, los sensores se siguen leyendo.

void conectarWiFi() {
  if (cfgSsid.length() == 0) return;
  WiFi.begin(cfgSsid.c_str(), cfgClave.length() ? cfgClave.c_str() : nullptr);
  tUltimoIntentoWiFi = millis();
}

void reconectarWiFi() {
  if (cfgSsid.length() == 0) return;
  Serial.print("[WiFi] Conectando a ");
  Serial.println(cfgSsid);
  WiFi.disconnect();
  wifiEstabaConectado = false;
  conectarWiFi();
}

void atenderWiFi() {
  if (cfgSsid.length() == 0) return;

  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiEstabaConectado) {
      Serial.print("[WiFi] Conectado. IP: ");
      Serial.println(WiFi.localIP());
      wifiEstabaConectado = true;
      sincronizarHora();
    }
    return;
  }

  if (wifiEstabaConectado) {
    Serial.println("[WiFi] Conexion perdida. Los eventos se guardaran localmente.");
    wifiEstabaConectado = false;
    tUltimoIntentoWiFi = millis();
    return;
  }

  if (millis() - tUltimoIntentoWiFi > INTERVALO_RECONEXION_MS) {
    Serial.println("[WiFi] Reintentando conexion en segundo plano.");
    WiFi.disconnect();
    conectarWiFi();
  }
}

void iniciarWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // con el ahorro de energia cada peticion tarda 100-300 ms mas
  iniciarEspNow();
  if (cfgSsid.length() > 0) {
    Serial.print("[WiFi] Conectando a ");
    Serial.println(cfgSsid);
    conectarWiFi();
  }
}

bool enviarMedicion(unsigned long numeroRegistro, const char* variable,
                    const char* zona, const char* sensorId, const char* nodoId,
                    int valor, long &latenciaMs) {
  if (!redLista()) return false;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.setReuse(usaHttps());
  http.begin(clienteBackend(), cfgServidor + "/mediciones");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", cfgToken);

  JsonDocument doc;
  doc["vivienda_id"]     = cfgVivienda;
  doc["zona"]            = zona;
  doc["nodo_id"]         = nodoId;
  doc["sensor_id"]       = sensorId;
  doc["variable"]        = variable;
  doc["valor"]           = valor;
  doc["unidad"]          = "estado";
  doc["numero_registro"] = numeroRegistro;

  String cuerpo;
  serializeJson(doc, cuerpo);

  unsigned long t0 = millis();
  int codigo = http.POST(cuerpo);
  latenciaMs = (long)(millis() - t0);
  http.end();

  Serial.print("[POST] registro=");
  Serial.print(numeroRegistro);
  Serial.print(" ");
  Serial.print(variable);
  Serial.print("=");
  Serial.print(valor);
  Serial.print(" codigo=");
  Serial.print(codigo);
  Serial.print(" latencia=");
  Serial.print(latenciaMs);
  Serial.println(" ms");

  if (codigo == 401 || codigo == 403) Serial.println("   Token rechazado. Revisa el comando token.");
  return (codigo == 201);
}

// Buffer en RAM para los eventos que no se pudieron enviar
void guardarEnBuffer(unsigned long numeroRegistro, const char* variable,
                     const char* zona, const char* sensorId, const char* nodoId, int valor) {
  if (eventosEnBuffer >= CAPACIDAD_BUFFER) {
    Serial.println("[Buffer] Lleno. Se descarta el evento mas antiguo.");
    for (int i = 1; i < CAPACIDAD_BUFFER; i++) bufferEventos[i - 1] = bufferEventos[i];
    eventosEnBuffer = CAPACIDAD_BUFFER - 1;
  }
  EventoPendiente &e = bufferEventos[eventosEnBuffer];
  e.numeroRegistro = numeroRegistro;
  e.valor = valor;
  strncpy(e.variable, variable, sizeof(e.variable) - 1);  e.variable[sizeof(e.variable) - 1] = '\0';
  strncpy(e.zona, zona, sizeof(e.zona) - 1);              e.zona[sizeof(e.zona) - 1] = '\0';
  strncpy(e.sensorId, sensorId, sizeof(e.sensorId) - 1);  e.sensorId[sizeof(e.sensorId) - 1] = '\0';
  strncpy(e.nodoId, nodoId, sizeof(e.nodoId) - 1);        e.nodoId[sizeof(e.nodoId) - 1] = '\0';
  eventosEnBuffer++;
  Serial.print("[Buffer] Eventos pendientes: ");
  Serial.println(eventosEnBuffer);
}

void intentarVaciarBuffer() {
  if (eventosEnBuffer == 0 || !redLista()) return;

  Serial.println("[Buffer] Sincronizando eventos pendientes.");
  int enviados = 0;
  for (int i = 0; i < eventosEnBuffer; i++) {
    long lat = 0;
    EventoPendiente &e = bufferEventos[i];
    if (!enviarMedicion(e.numeroRegistro, e.variable, e.zona, e.sensorId, e.nodoId, e.valor, lat)) break;
    enviados++;
    enviosExitosos++;
  }

  if (enviados > 0) {
    for (int i = enviados; i < eventosEnBuffer; i++) bufferEventos[i - enviados] = bufferEventos[i];
    eventosEnBuffer -= enviados;
    Serial.print("[Buffer] Sincronizados: ");
    Serial.print(enviados);
    Serial.print(". Restantes: ");
    Serial.println(eventosEnBuffer);
  }
}

void guardarDatosAlarma(const char* variable, const char* zona, const char* sensorId, const char* nodoId) {
  strncpy(motivoAlarma, variable, sizeof(motivoAlarma) - 1); motivoAlarma[sizeof(motivoAlarma) - 1] = '\0';
  strncpy(zonaAlarma, zona, sizeof(zonaAlarma) - 1);         zonaAlarma[sizeof(zonaAlarma) - 1] = '\0';
  strncpy(sensorAlarma, sensorId, sizeof(sensorAlarma) - 1); sensorAlarma[sizeof(sensorAlarma) - 1] = '\0';
  strncpy(nodoAlarma, nodoId, sizeof(nodoAlarma) - 1);       nodoAlarma[sizeof(nodoAlarma) - 1] = '\0';
}

// Decide que hacer con un evento. La sirena suena solo si el sistema esta armado,
// el evento es de alarma y no hay modo silencioso. El registro se hace siempre:
// el modo silencioso suprime el ruido, no la evidencia.
void procesarEvento(const char* variable, const char* zona,
                    const char* sensorId, const char* nodoId, int valor, bool esAlarma) {
  contadorRegistro++;

  Serial.print("[Evento] registro=");
  Serial.print(contadorRegistro);
  Serial.print(" ");
  Serial.print(variable);
  Serial.print(" valor=");
  Serial.print(valor);
  Serial.print(" zona=");
  Serial.print(zona);
  Serial.print(" sensor=");
  Serial.print(sensorId);
  Serial.print(" nodo=");
  Serial.println(nodoId);

  if (esAlarma && sistemaArmado) {
    guardarDatosAlarma(variable, zona, sensorId, nodoId);
    if (modoSilencioso) {
      Serial.println("   ALARMA en modo silencioso. Se notifica sin activar la salida.");
      tDisparoAlarma = millis();
      enviarAlarma(true, true);   // un solo intento, solo sirve para la notificacion
    } else {
      Serial.println("   ALARMA. Se activa la salida audible.");
      if (!sirenaPorAlarma) {
        alarmaConfirmada = false;
        alarmaReportadaActiva = false;
      }
      sirenaPorAlarma = true;
      tInicioSirena = millis();
      tDisparoAlarma = tInicioSirena;
      // El aviso sale antes que el registro de la medicion para no retrasar la notificacion
      sincronizarAlarma();
    }
  } else if (esAlarma) {
    Serial.println("   Sistema desarmado. Solo se registra el evento.");
  }

  bool enviado = false;
  long latencia = 0;

  if (!redLista()) {
    Serial.println("   Sin conexion. El evento se conserva localmente.");
  } else {
    for (int intento = 1; intento <= MAX_REINTENTOS && !enviado; intento++) {
      if (intento > 1) { Serial.print("   [Reintento "); Serial.print(intento); Serial.println("]"); delay(500); }
      enviado = enviarMedicion(contadorRegistro, variable, zona, sensorId, nodoId, valor, latencia);
    }
  }

  if (enviado) {
    enviosExitosos++;
  } else {
    enviosFallidos++;
    guardarEnBuffer(contadorRegistro, variable, zona, sensorId, nodoId, valor);
  }

  Serial.print("[Contadores] exitosos=");
  Serial.print(enviosExitosos);
  Serial.print(" fallidos=");
  Serial.println(enviosFallidos);
}

// Avisa al backend de una alarma. Con silenciosa = true es solo para notificar,
// porque no hay sirena que apagar despues.
bool enviarAlarma(bool activa, bool silenciosa) {
  if (!redLista()) return false;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.setReuse(usaHttps());
  http.begin(clienteBackend(), cfgServidor + "/alarma");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", cfgToken);

  JsonDocument doc;
  doc["vivienda_id"] = cfgVivienda;
  doc["nodo_id"]     = nodoAlarma[0] ? nodoAlarma : NODO_ID;
  doc["activa"]      = activa;
  if (activa) {
    doc["motivo"]    = motivoAlarma;
    doc["zona"]      = zonaAlarma;
    doc["sensor_id"] = sensorAlarma;
    doc["silenciosa"] = silenciosa;
    if (tDisparoAlarma) doc["retraso_ms"] = (unsigned long)(millis() - tDisparoAlarma);
  }
  String cuerpo;
  serializeJson(doc, cuerpo);

  int codigo = http.POST(cuerpo);
  http.end();

  Serial.print("[Alarma] Aviso al backend activa=");
  Serial.print(activa ? "true" : "false");
  Serial.print(silenciosa ? " (silenciosa)" : "");
  Serial.print(" codigo=");
  Serial.println(codigo);

  return (codigo == 200);
}

// Mantiene al backend al tanto de si la alarma suena. Sin red, queda pendiente.
void sincronizarAlarma() {
  if (alarmaReportadaActiva == sirenaPorAlarma) return;
  if (!redLista()) return;
  if (millis() - tUltimoReporteAlarma < INTERVALO_REPORTE_ALARMA_MS) return;

  tUltimoReporteAlarma = millis();
  if (enviarAlarma(sirenaPorAlarma, false)) alarmaReportadaActiva = sirenaPorAlarma;
}

void apagarAlarmaLocal(const char* motivo) {
  if (!sirenaPorAlarma) return;
  sirenaPorAlarma = false;
  alarmaConfirmada = false;
  Serial.print("[Alarma] Apagada. Motivo: ");
  Serial.println(motivo);
}

// Consulta el estado de armado en el backend (cada INTERVALO_ESTADO_MS)
void consultarEstado() {
  if (!redLista()) return;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.setReuse(usaHttps());
  http.begin(clienteBackend(), cfgServidor + "/estado?vivienda_id=" + cfgVivienda);
  http.addHeader("X-Device-Token", cfgToken);
  int codigo = http.GET();

  if (codigo == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {
      bool armadoAntes = sistemaArmado;
      sistemaArmado  = doc["armado"]          | false;
      armadoConocido = true;
      modoSilencioso = doc["modo_silencioso"] | false;
      salidaManual   = doc["actuador_activo"] | false;
      bool alarmaRemota = doc["alarma_activa"] | false;

      if (armadoAntes != sistemaArmado) {
        Serial.print("[Estado] El sistema quedo ");
        Serial.println(sistemaArmado ? "ARMADO" : "DESARMADO");
      }

      if (sirenaPorAlarma) {
        if (!sistemaArmado) {
          apagarAlarmaLocal("el sistema se desarmo");
        } else if (alarmaRemota) {
          alarmaConfirmada = true;
        } else if (alarmaConfirmada) {
          // El backend la tenia activa y ya no: la apagaron desde la app. Si aun
          // no la conocia es solo un desfase del aviso y no se apaga.
          apagarAlarmaLocal("apagada desde la aplicacion");
        }
      }
    }
  } else if (codigo == 401 || codigo == 403) {
    Serial.println("[Estado] Token rechazado. Revisa el comando token.");
  }
  http.end();
}

// La salida se activa por una alarma en curso o por una prueba manual desde la app
void actualizarSalida() {
  if (sirenaPorAlarma && millis() - tInicioSirena > DURACION_SIRENA_MS) {
    apagarAlarmaLocal("se cumplio el tiempo maximo de sirena");
  }

  bool activa = sirenaPorAlarma || salidaManual;
  bool nivel = false;
  if (activa) {
    nivel = SALIDA_INTERMITENTE ? ((millis() / INTERVALO_PARPADEO_MS) % 2 == 0) : true;
  }
  digitalWrite(PIN_SALIDA, nivel ? HIGH : LOW);
  digitalWrite(PIN_LED_ESTADO, nivel ? HIGH : LOW);
}

// Recepcion de nodos (ESP-NOW): corre en la tarea de Wi-Fi y solo copia el paquete a una cola; el ciclo principal lo
// procesa, porque procesar un evento hace peticiones HTTP.
const int CAP_COLA_RX = 8;
PaqueteSensor colaRx[CAP_COLA_RX];
uint8_t colaRxMac[CAP_COLA_RX][6];
int8_t colaRxRssi[CAP_COLA_RX];
volatile int rxEscribir = 0;
volatile int rxLeer = 0;

// Acepta la peticion de un C3 y le contesta por broadcast con su propia MAC
// dentro, para que solo ese nodo la tome como suya.
void responderEmparejamiento(const uint8_t* mac, const PaqueteSensor* peticion) {
  if (!emparejando) return;
  if (indicePareado(mac) < 0) {
    if (numPareados >= MAX_PAREADOS) { nodosLlenos = true; return; }
    memcpy(pareados[numPareados++], mac, 6);
  }

  memcpy(macNueva, mac, 6);
  strncpy(nombreNuevo, peticion->nodoId, sizeof(nombreNuevo) - 1);
  nombreNuevo[sizeof(nombreNuevo) - 1] = '\0';
  nodoNuevo = true;

  PaqueteSensor r;
  memset(&r, 0, sizeof(r));
  r.magia[0] = 'S';
  r.magia[1] = 'R';
  r.version = 1;
  r.tipo = TIPO_RESPUESTA;
  r.secuencia = peticion->secuencia;   // el C3 comprueba que contesta a SU peticion
  strncpy(r.nodoId, NODO_ID, sizeof(r.nodoId) - 1);
  snprintf(r.variable, sizeof(r.variable), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  firmarPaquete(&r);
  esp_now_send(MAC_BROADCAST, (const uint8_t*)&r, sizeof(r));
}

// Los C3 solo escuchan un instante tras transmitir, asi que la respuesta con el estado de armado sale de inmediato desde la
// recepcion: unicast cifrado y firmada con llave (broadcast sin ella), repitiendo la secuencia para que no sirva una vieja.
void responderArmado(const uint8_t* mac, uint32_t secuencia) {
  if (!armadoConocido) return;   // el C3 conserva su ultimo valor (por defecto, armado)
  PaqueteSensor r;
  memset(&r, 0, sizeof(r));
  r.magia[0] = 'S';
  r.magia[1] = 'R';
  r.version = 1;
  r.tipo = TIPO_ARMADO;
  r.secuencia = secuencia;
  strncpy(r.nodoId, NODO_ID, sizeof(r.nodoId) - 1);
  snprintf(r.variable, sizeof(r.variable), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  r.valor = sistemaArmado ? 1 : 0;
  firmarPaquete(&r);
  if (cifradoActivo) {
    if (!esp_now_is_peer_exist(mac)) return;   // solo nodos emparejados
    esp_now_send(mac, (const uint8_t*)&r, sizeof(r));
  } else {
    esp_now_send(MAC_BROADCAST, (const uint8_t*)&r, sizeof(r));
  }
}

void guardarPaqueteRx(const uint8_t* mac, const uint8_t* datos, int largo, int rssi) {
  if (largo != (int)sizeof(PaqueteSensor)) return;
  const PaqueteSensor* p = (const PaqueteSensor*)datos;
  if (p->magia[0] != 'S' || p->magia[1] != 'R' || p->version != 1) return;
  if (!paqueteAutentico(p)) return;   // firma invalida: no se emparejan ni se atienden

  if (p->tipo == TIPO_EMPAREJAR) { responderEmparejamiento(mac, p); return; }
  if (p->tipo == TIPO_RESPUESTA || p->tipo == TIPO_ARMADO) return;
  if (!macPermitida(mac)) {
    memcpy(macDesconocida, mac, 6);
    hayDesconocido = true;
    return;
  }
  if (p->tipo == TIPO_EVENTO || p->tipo == TIPO_ESTADO || p->tipo == TIPO_HOLA) responderArmado(mac, p->secuencia);

  int sig = (rxEscribir + 1) % CAP_COLA_RX;
  if (sig == rxLeer) return;   // cola llena: el nodo reintentara
  memcpy(&colaRx[rxEscribir], datos, sizeof(PaqueteSensor));
  memcpy(colaRxMac[rxEscribir], mac, 6);
  colaRxRssi[rxEscribir] = (int8_t)rssi;
  rxEscribir = sig;
}

// La firma de la funcion de recepcion cambio en IDF 5 (core ESP32 3.x)
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
void alRecibirEspNow(const esp_now_recv_info_t* info, const uint8_t* datos, int largo) {
  guardarPaqueteRx(info->src_addr, datos, largo, info->rx_ctrl ? info->rx_ctrl->rssi : 0);
}
#else
void alRecibirEspNow(const uint8_t* mac, const uint8_t* datos, int largo) {
  guardarPaqueteRx(mac, datos, largo, 0);   // el core antiguo no da el RSSI
}
#endif

// Anti-replay: se descartan los reintentos (misma secuencia) y cualquier secuencia MENOR que la ultima aceptada, asi un
// paquete grabado y reenviado no vale. Al reiniciar el concentrador la tabla queda vacia y se vuelve a aprender.
const int MAX_ORIGENES = 8;
OrigenRemoto origenes[MAX_ORIGENES];

bool esDuplicado(const uint8_t* mac, uint32_t secuencia) {
  for (int i = 0; i < MAX_ORIGENES; i++) {
    if (origenes[i].usado && memcmp(origenes[i].mac, mac, 6) == 0) {
      if (secuencia <= origenes[i].ultimaSecuencia) return true;
      origenes[i].ultimaSecuencia = secuencia;
      return false;
    }
  }
  for (int i = 0; i < MAX_ORIGENES; i++) {
    if (!origenes[i].usado) {
      origenes[i].usado = true;
      memcpy(origenes[i].mac, mac, 6);
      origenes[i].ultimaSecuencia = secuencia;
      return false;
    }
  }
  return true;   // tabla llena: se descarta en vez de aceptar sin comprobar
}

// Ultimo estado de cada sensor remoto: el primero se registra sin disparar
// alarma y sirve para detectar cambios perdidos.
EstadoRemoto estadosRemotos[8];

EstadoRemoto* buscarEstado(const char* sensorId) {
  for (int i = 0; i < 8; i++) {
    if (estadosRemotos[i].usado && strcmp(estadosRemotos[i].sensorId, sensorId) == 0) return &estadosRemotos[i];
  }
  return nullptr;
}

EstadoRemoto* crearEstado(const char* sensorId, int valor) {
  for (int i = 0; i < 8; i++) {
    if (!estadosRemotos[i].usado) {
      estadosRemotos[i].usado = true;
      strncpy(estadosRemotos[i].sensorId, sensorId, sizeof(estadosRemotos[i].sensorId) - 1);
      estadosRemotos[i].sensorId[sizeof(estadosRemotos[i].sensorId) - 1] = '\0';
      estadosRemotos[i].valor = valor;
      return &estadosRemotos[i];
    }
  }
  return nullptr;
}

// Registro automatico de nodos y sensores: cada nodo escuchado y cada sensor declarado se reportan en un POST /nodos/latido
// (cada 30 s, o enseguida si aparece algo nuevo), asi la app descubre sensores y detecta nodos caidos.

const unsigned long LATIDO_INTERVALO_MS = 30000;

NodoVisto nodosVistos[MAX_NODOS];
bool latidoUrgente = false;
unsigned long tUltimoLatido = 0;

NodoVisto* tocarNodoVisto(const char* nodoId, int rssi) {
  NodoVisto* libre = nullptr;
  for (int i = 0; i < MAX_NODOS; i++) {
    if (nodosVistos[i].usado && strcmp(nodosVistos[i].nodoId, nodoId) == 0) {
      nodosVistos[i].ultimoMs = millis();
      if (rssi != 0) nodosVistos[i].rssi = rssi;
      return &nodosVistos[i];
    }
    if (!nodosVistos[i].usado && !libre) libre = &nodosVistos[i];
  }
  if (!libre) return nullptr;
  memset(libre, 0, sizeof(*libre));
  libre->usado = true;
  strncpy(libre->nodoId, nodoId, sizeof(libre->nodoId) - 1);
  libre->ultimoMs = millis();
  libre->rssi = rssi;
  latidoUrgente = true;
  return libre;
}

void recordarSensor(NodoVisto* n, const char* sensorId, const char* variable, const char* zona) {
  if (!n || !sensorId[0]) return;
  for (int i = 0; i < n->numSensores; i++) {
    if (strcmp(n->sensores[i].sensorId, sensorId) == 0) return;
  }
  if (n->numSensores >= MAX_SENSORES_NODO) return;
  SensorVisto &s = n->sensores[n->numSensores++];
  strncpy(s.sensorId, sensorId, sizeof(s.sensorId) - 1);
  strncpy(s.variable, variable, sizeof(s.variable) - 1);
  strncpy(s.zona, zona, sizeof(s.zona) - 1);
  latidoUrgente = true;
}

void enviarLatidos() {
  if (!redLista()) return;
  tUltimoLatido = millis();
  latidoUrgente = false;

  JsonDocument doc;
  JsonArray lista = doc["nodos"].to<JsonArray>();

  // Sensores conectados directo a este concentrador
  if (NUM_CONTACTOS + NUM_PIRS > 0) {
    JsonObject o = lista.add<JsonObject>();
    o["nodo_id"] = NODO_ID;
    o["hace_s"] = 0;
    JsonArray ss = o["sensores"].to<JsonArray>();
    for (int i = 0; i < NUM_CONTACTOS; i++) {
      JsonObject s = ss.add<JsonObject>();
      s["sensor_id"] = contactos[i].sensorId; s["variable"] = "estado_puerta"; s["zona"] = contactos[i].zona;
    }
    for (int i = 0; i < NUM_PIRS; i++) {
      JsonObject s = ss.add<JsonObject>();
      s["sensor_id"] = pirs[i].sensorId; s["variable"] = "movimiento"; s["zona"] = pirs[i].zona;
    }
  }

  for (int i = 0; i < MAX_NODOS; i++) {
    NodoVisto &n = nodosVistos[i];
    if (!n.usado) continue;
    JsonObject o = lista.add<JsonObject>();
    o["nodo_id"] = n.nodoId;
    o["hace_s"] = (millis() - n.ultimoMs) / 1000;
    if (n.rssi != 0) o["rssi"] = n.rssi;
    JsonArray ss = o["sensores"].to<JsonArray>();
    for (int j = 0; j < n.numSensores; j++) {
      JsonObject s = ss.add<JsonObject>();
      s["sensor_id"] = n.sensores[j].sensorId;
      s["variable"] = n.sensores[j].variable;
      s["zona"] = n.sensores[j].zona;
    }
  }

  String cuerpo;
  serializeJson(doc, cuerpo);

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.setReuse(usaHttps());
  http.begin(clienteBackend(), cfgServidor + "/nodos/latido");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", cfgToken);
  int codigo = http.POST(cuerpo);
  http.end();

  Serial.print("[Latido] nodos="); Serial.print(lista.size());
  Serial.print(" codigo="); Serial.println(codigo);
  if (codigo == 401 || codigo == 403) Serial.println("   Token rechazado. Revisa el comando token.");
  if (codigo != 200) latidoUrgente = false;   // se reintenta en el siguiente intervalo
}

void atenderLatidos() {
  unsigned long espera = latidoUrgente ? 1500 : LATIDO_INTERVALO_MS;   // agrupa varios hallazgos
  if (millis() - tUltimoLatido >= espera) enviarLatidos();
}

void procesarPaqueteRemoto(PaqueteSensor &p, const uint8_t* mac, int rssi) {
  p.nodoId[sizeof(p.nodoId) - 1] = '\0';
  p.sensorId[sizeof(p.sensorId) - 1] = '\0';
  p.variable[sizeof(p.variable) - 1] = '\0';
  p.zona[sizeof(p.zona) - 1] = '\0';

  // Cualquier paquete valido demuestra que el nodo esta vivo
  NodoVisto* nodo = tocarNodoVisto(p.nodoId, rssi);
  if (p.tipo == TIPO_HOLA) return;

  bool esContacto = strcmp(p.variable, "estado_puerta") == 0;
  bool esMovimiento = strcmp(p.variable, "movimiento") == 0;
  if (!esContacto && !esMovimiento) return;
  recordarSensor(nodo, p.sensorId, p.variable, p.zona);
  if (esDuplicado(mac, p.secuencia)) return;

  Serial.print("[ESP-NOW] ");
  Serial.print(p.tipo == TIPO_EVENTO ? "evento" : "estado");
  Serial.print(" de ");
  Serial.print(p.nodoId);
  Serial.print(": ");
  Serial.print(p.sensorId);
  Serial.print(" valor=");
  Serial.println(p.valor);

  if (p.tipo == TIPO_EVENTO) {
    if (esContacto) {
      EstadoRemoto* e = buscarEstado(p.sensorId);
      if (e) e->valor = p.valor; else crearEstado(p.sensorId, p.valor);
    }
    procesarEvento(p.variable, p.zona, p.sensorId, p.nodoId, p.valor, p.valor == 1);
    return;
  }

  if (p.tipo == TIPO_ESTADO) {
    EstadoRemoto* e = buscarEstado(p.sensorId);
    if (!e) {
      // Primera vez que se ve el sensor: se registra sin activar alarma
      crearEstado(p.sensorId, p.valor);
      procesarEvento(p.variable, p.zona, p.sensorId, p.nodoId, p.valor, false);
    } else if (esContacto && e->valor != p.valor) {
      // El contacto cambio y el evento se perdio en el camino
      e->valor = p.valor;
      procesarEvento(p.variable, p.zona, p.sensorId, p.nodoId, p.valor, p.valor == 1);
    }
  }
}

void atenderRemotos() {
  while (rxLeer != rxEscribir) {
    PaqueteSensor p;
    uint8_t mac[6];
    int8_t rssi = colaRxRssi[rxLeer];
    memcpy(&p, &colaRx[rxLeer], sizeof(p));
    memcpy(mac, colaRxMac[rxLeer], 6);
    rxLeer = (rxLeer + 1) % CAP_COLA_RX;
    procesarPaqueteRemoto(p, mac, rssi);
  }
}

void abrirEmparejamiento() {
  emparejando = true;
  tFinEmparejar = millis() + DURACION_EMPAREJAR_MS;
  Serial.println("[Emparejar] Abierto por 2 minutos. Enciende el C3 (o espera a que busque).");
}

// Corre en el ciclo principal: guarda en flash y avisa lo que paso en la recepcion
void atenderEmparejamiento() {
  if (nodoNuevo) {
    nodoNuevo = false;
    registrarPares();
    guardarNodos();
    Serial.print("[Emparejar] Nodo enlazado: ");
    Serial.print(nombreNuevo);
    Serial.print(" (");
    Serial.print(macATexto(macNueva));
    Serial.println(")");
  }
  if (nodosLlenos) {
    nodosLlenos = false;
    Serial.println("[Emparejar] Ya hay 6 nodos. Usa olvidarnodos para liberar espacio.");
  }
  if (emparejando && (long)(millis() - tFinEmparejar) >= 0) {
    emparejando = false;
    Serial.println("[Emparejar] Cerrado.");
  }

  static unsigned long tAviso = 0;
  if (hayDesconocido) {
    hayDesconocido = false;
    if (millis() - tAviso > 10000) {
      tAviso = millis();
      Serial.print("[ESP-NOW] Paquete de un nodo sin emparejar (");
      Serial.print(macATexto(macDesconocida));
      Serial.println("). Escribe emparejar para aceptarlo.");
    }
  }
}

String lineaSerie;

String enmascarar(const String& s, int visibles) {
  if (s.length() == 0) return "(vacio)";
  if ((int)s.length() <= visibles) return "****";
  return s.substring(0, visibles) + "...";
}

void imprimirMac(const char* etiqueta) {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);   // WiFi.macAddress() puede dar ceros al arrancar
  Serial.print(etiqueta);
  Serial.println(macATexto(mac));
}

void mostrarConfig() {
  Serial.println("---------- Configuracion ----------");
  Serial.print("Red:        "); Serial.println(cfgSsid.length() ? cfgSsid : String("(sin configurar)"));
  Serial.print("Clave:      "); Serial.println(cfgClave.length() ? "****" : "(vacia)");
  Serial.print("Wi-Fi:      "); Serial.println(WiFi.status() == WL_CONNECTED ? "conectado" : "sin conexion");
  Serial.print("Servidor:   "); Serial.println(cfgServidor);
  Serial.print("Token:      "); Serial.println(enmascarar(cfgToken, 6));
  Serial.print("Vivienda:   "); Serial.println(cfgVivienda);
  Serial.print("Nodos C3:   "); Serial.println(numPareados);
  Serial.print("Cifrado:    "); Serial.println(cifradoActivo ? "activo (llave guardada)" : "INACTIVO (sin llave)");
  Serial.println("-----------------------------------");
}

void mostrarAyuda() {
  Serial.println("Comandos:");
  Serial.println("  wifi NOMBRE      nombre de la red Wi-Fi");
  Serial.println("  clave PASSWORD   clave de la red (sin valor = red abierta)");
  Serial.println("  conectar         reintenta la conexion con lo guardado");
  Serial.println("  token hv_...     token de la vivienda");
  Serial.println("  servidor URL     ej. http://dominio:8080 o https://dominio");
  Serial.println("  vivienda ID      solo con el token global antiguo");
  Serial.println("  emparejar        abre 2 min para enlazar C3 (emparejar cancelar)");
  Serial.println("  nodos            lista los C3 emparejados");
  Serial.println("  olvidarnodos     borra todos los emparejamientos");
  Serial.println("  llave nueva      genera la llave de cifrado (tambien: mostrar, borrar, o 32 digitos hex)");
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
    Serial.println("Clave guardada.");
    reconectarWiFi();
  } else if (cmd == "conectar") {
    reconectarWiFi();
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
  } else if (cmd == "vivienda") {
    if (arg.length() == 0) { Serial.println("Uso: vivienda ID"); return; }
    cfgVivienda = arg;
    prefs.putString("vivienda", cfgVivienda);
    Serial.println("Vivienda guardada.");
  } else if (cmd == "emparejar") {
    if (arg == "cancelar") { emparejando = false; Serial.println("[Emparejar] Cerrado."); }
    else abrirEmparejamiento();
  } else if (cmd == "nodos") {
    if (numPareados == 0) Serial.println("Sin nodos emparejados.");
    for (int i = 0; i < numPareados; i++) Serial.println(macATexto(pareados[i]));
  } else if (cmd == "olvidarnodos") {
    for (int i = 0; i < numPareados; i++) {
      if (esp_now_is_peer_exist(pareados[i])) esp_now_del_peer(pareados[i]);
    }
    numPareados = 0;
    guardarNodos();
    Serial.println("Emparejamientos borrados.");
  } else if (cmd == "llave") {
    String a = arg; a.toLowerCase();
    if (a == "nueva") {
      uint8_t k[16];
      esp_fill_random(k, 16);
      char t[33];
      for (int i = 0; i < 16; i++) snprintf(t + 2 * i, 3, "%02x", k[i]);
      prefs.putBytes("llave", k, 16);
      Serial.println("Llave nueva guardada. Escribela en cada nodo C3 con: llave <32 digitos>");
      Serial.print("Llave: "); Serial.println(t);
      Serial.println("Reiniciando. Despues haz emparejar de nuevo en los nodos.");
      delay(300);
      ESP.restart();
    } else if (a == "mostrar") {
      String h = llaveComoHex();
      if (h.length()) { Serial.print("Llave: "); Serial.println(h); }
      else Serial.println("No hay llave guardada.");
    } else if (a == "borrar") {
      prefs.remove("llave");
      Serial.println("Llave borrada. Reiniciando (quedara sin cifrar).");
      delay(300);
      ESP.restart();
    } else if (guardarLlaveHex(a)) {
      Serial.println("Llave guardada. Reiniciando.");
      delay(300);
      ESP.restart();
    } else {
      Serial.println("Uso: llave nueva | llave mostrar | llave 32_digitos_hex | llave borrar");
    }
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

// Con cifrado, cada C3 emparejado se registra como par cifrado
void registrarPares() {
  if (!cifradoActivo) return;
  for (int i = 0; i < numPareados; i++) {
    if (esp_now_is_peer_exist(pareados[i])) continue;
    esp_now_peer_info_t par = {};
    memcpy(par.peer_addr, pareados[i], 6);
    par.channel = 0;
    par.ifidx = WIFI_IF_STA;
    par.encrypt = true;
    lmkDeNodo(pareados[i], par.lmk);   // LMK propia de cada nodo
    if (esp_now_add_peer(&par) != ESP_OK) Serial.printf("[ESP-NOW] No se pudo registrar el nodo %d cifrado.\n", i + 1);
  }
}

void iniciarEspNow() {
  imprimirMac("[MAC] Esta placa (concentrador): ");

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] No se pudo iniciar. No se recibiran nodos C3.");
    return;
  }
  if (cifradoActivo) esp_now_set_pmk(pmkDerivada);

  // Par de broadcast: con el se contesta a los C3 que piden emparejarse
  esp_now_peer_info_t bc = {};
  memcpy(bc.peer_addr, MAC_BROADCAST, 6);
  bc.channel = 0;
  bc.ifidx = WIFI_IF_STA;
  bc.encrypt = false;
  esp_now_add_peer(&bc);

  registrarPares();
  esp_now_register_recv_cb(alRecibirEspNow);
  Serial.println("[ESP-NOW] Escuchando nodos C3.");
}

void setup() {
  Serial.begin(115200);
  delay(300);

  for (int i = 0; i < NUM_CONTACTOS; i++) {
    pinMode(contactos[i].pin, INPUT_PULLUP);
  }
  // El AM312 maneja su salida activamente: sin resistencias internas
  for (int i = 0; i < NUM_PIRS; i++) {
    pinMode(pirs[i].pin, INPUT);
  }
  pinMode(PIN_SALIDA, OUTPUT);
  digitalWrite(PIN_SALIDA, LOW);
  pinMode(PIN_LED_ESTADO, OUTPUT);
  digitalWrite(PIN_LED_ESTADO, LOW);

  for (int i = 0; i < NUM_CONTACTOS; i++) {
    contactos[i].estable = digitalRead(contactos[i].pin);
    contactos[i].previa  = contactos[i].estable;
  }

  cargarConfig();
  cargarLlave();

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Concentrador - Sistema de seguridad");
  Serial.print(" Nodo: "); Serial.println(NODO_ID);
  Serial.println(USAR_SENSORES_LOCALES ? " Sensores locales activos" : " Sensores locales: desactivados (los aportan los C3)");
  Serial.println("==========================================");

  if (NUM_PIRS > 0) {
    Serial.print("[PIR] Estabilizando el sensor durante ");
    Serial.print(PIR_ESTABILIZACION_MS / 1000);
    Serial.println(" s. Sus lecturas se ignoran hasta entonces.");
  }

  iniciarWiFi();
  mostrarConfig();
  if (numPareados == 0) Serial.println("[Emparejar] Sin nodos C3. Escribe emparejar y enciende el C3.");
  Serial.println("Escribe ayuda para ver los comandos.");
}

void loop() {
  atenderConsola();

  // Contactos magneticos con filtrado de rebote
  for (int i = 0; i < NUM_CONTACTOS; i++) {
    Contacto &c = contactos[i];
    int lectura = digitalRead(c.pin);

    if (lectura != c.previa) {
      c.tCambio = millis();
      c.previa = lectura;
    }

    if ((millis() - c.tCambio) > DEBOUNCE_MS && lectura != c.estable) {
      c.estable = lectura;
      // Con pull-up, circuito abierto = el iman se separo = puerta abierta
      int valor = (c.estable == HIGH) ? 1 : 0;
      procesarEvento("estado_puerta", c.zona, c.sensorId, NODO_ID, valor, valor == 1);
    }
  }

  if (NUM_PIRS > 0) {
    if (!pirListo) {
      // Las interrupciones se activan al terminar la estabilizacion para que el
      // arranque del sensor no cuente como evento
      if (millis() >= PIR_ESTABILIZACION_MS) {
        pirListo = true;
        for (int i = 0; i < NUM_PIRS; i++) {
          pirs[i].pulso = false;
          attachInterruptArg(digitalPinToInterrupt(pirs[i].pin), alDetectarPir,
                             (void*)(intptr_t)i, RISING);
          Serial.print("[PIR] ");
          Serial.print(pirs[i].sensorId);
          Serial.print(" listo en GPIO ");
          Serial.print(pirs[i].pin);
          Serial.print(". Lectura inicial: ");
          Serial.println(digitalRead(pirs[i].pin));
          pirs[i].previa = digitalRead(pirs[i].pin);
        }
      }
    } else {
      for (int i = 0; i < NUM_PIRS; i++) {
        Pir &p = pirs[i];
        // Respaldo por sondeo por si la interrupcion no se dispara
        int lect = digitalRead(p.pin);
        if (lect == HIGH && p.previa == LOW) p.pulso = true;
        p.previa = lect;
        if (!p.pulso) continue;
        p.pulso = false;
        Serial.print("[PIR] Pulso detectado en ");
        Serial.println(p.sensorId);

        if (p.tUltimo == 0 || millis() - p.tUltimo > BLOQUEO_PIR_MS) {
          p.tUltimo = millis();
          procesarEvento("movimiento", p.zona, p.sensorId, NODO_ID, 1, true);
        } else {
          Serial.println("   Ignorado por el bloqueo entre eventos de movimiento.");
        }
      }
    }
  }

  atenderRemotos();
  atenderEmparejamiento();
  atenderLatidos();

  atenderWiFi();
  if (redLista()) intentarVaciarBuffer();
  avisarConfigIncompleta();

  if (millis() - tUltimoEstado > INTERVALO_ESTADO_MS) {
    tUltimoEstado = millis();
    consultarEstado();
  }

  actualizarSalida();
  sincronizarAlarma();

  delay(10);
}
