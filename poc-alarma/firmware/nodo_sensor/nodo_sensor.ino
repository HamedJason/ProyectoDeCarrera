/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Nodo sensor sobre ESP32 DevKit
 *
 * Cadena demostrada por este firmware:
 *   entrada fisica -> procesamiento local -> Wi-Fi -> POST al backend
 *                                                  -> consulta de estado
 *                                                  -> salida audible
 *
 * Este nodo es el RECEPTOR: la unica placa conectada al Wi-Fi y al backend.
 * Recibe por ESP-NOW los eventos de los nodos perifericos (nodo_c3.ino, un
 * ESP32-C3 con los sensores) y ejecuta con ellos toda la logica de alarma.
 * Tambien puede leer sensores propios si USAR_SENSORES_LOCALES es true.
 *
 * Entradas soportadas (varias de cada una, se declaran en las tablas de abajo):
 *   - Contactos magneticos MC-38 en puertas o ventanas (contacto seco)
 *   - Sensores infrarrojos pasivos AM312 para movimiento
 *
 * El nodo no sabe si un contacto esta en una puerta o en una ventana: solo
 * reporta abierto/cerrado con un identificador. El residente decide el tipo y
 * el nombre desde la aplicacion, que registra cada sensor la primera vez que
 * reporta.
 *
 * El AM312 opera entre 2.7 y 12 V y entrega 3.3 V en su salida, por lo que se
 * conecta directamente al ESP32 sin divisor de voltaje. A diferencia del
 * HC-SR501 no tiene ajustes y su retardo interno es fijo, de unos 2 segundos.
 *
 * Flujo de la alarma:
 *   1. Un sensor dispara con el sistema armado y el modo silencioso apagado.
 *   2. La salida (LED o sirena) parpadea y el nodo avisa al backend (POST /alarma).
 *   3. La aplicacion muestra ALARMA ACTIVA con el boton "Apagar alarma".
 *   4. La alarma termina al apagarla desde la aplicacion, al desarmar el
 *      sistema o al cumplirse el tiempo maximo de sirena.
 *
 * Librerias necesarias (Gestor de librerias de Arduino IDE):
 *   - ArduinoJson (Benoit Blanchon), version 7.x
 * WiFi.h y HTTPClient.h vienen incluidas con el core de ESP32.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_now.h>
#include <esp_idf_version.h>
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include <esp_mac.h>
#else
#include <esp_system.h>
#endif

// ===================== Configuracion editable =====================

const char* WIFI_SSID     = "NOMBRE_DE_TU_RED";
const char* WIFI_PASSWORD = "PASSWORD_DE_TU_RED";

// URL del backend desplegado. Debe terminar sin diagonal final.
const char* BACKEND_BASE  = "http://privadaochil.ddns.net:8080";

// Debe coincidir EXACTAMENTE con el DEVICE_TOKEN del archivo .env del servidor.
const char* DEVICE_TOKEN  = "alarma-uabc-2026";

// Identificacion logica dentro del modelo vivienda / zona / nodo / sensor
const char* VIVIENDA_ID = "casa-001";
const char* NODO_ID     = "nodo-01";

// ===================== Nodos perifericos (ESP-NOW) =====================

// Si es true, este nodo tambien lee los sensores de las tablas de abajo. Con el
// ESP32-C3 encargado de los sensores se deja en false.
const bool USAR_SENSORES_LOCALES = false;

// Cifrado ESP-NOW (opcional). Debe coincidir con nodo_c3.ino. Si se activa,
// hay que poner la MAC del C3 (la imprime en su Serial: "[MAC] Esta placa").
const bool USAR_CIFRADO = false;
const char* CLAVE_PMK = "pmk-uabc-2026-a1";   // exactamente 16 caracteres
const char* CLAVE_LMK = "lmk-uabc-2026-b2";   // exactamente 16 caracteres
uint8_t MAC_C3[6] = { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };

// ===================== Hardware =====================

const int PIN_SALIDA = 2;   // LED integrado o entrada del relevador de la sirena

/*
 * Contactos magneticos MC-38. Un cable al pin y el otro a GND; el pull-up
 * interno hace el resto. Pines recomendados: 4, 16, 17, 21, 22, 23.
 * Evitar 0, 2, 5, 12, 15 (arranque) y 34-39 (no tienen pull-up interno).
 *
 * "sensorId" es el identificador que veran el backend y la aplicacion. No lo
 * cambies despues de registrarlo o se creara como un sensor nuevo.
 * "zona" es solo el lugar; el nombre y el tipo se ponen en la aplicacion.
 * Cada tabla debe tener al menos un sensor (un arreglo vacio no compila).
 */
struct Contacto {
  const char* sensorId;
  const char* zona;
  int pin;
  int estable;             // estado ya filtrado
  int previa;              // ultima lectura cruda
  unsigned long tCambio;
};

Contacto contactos[] = {
  { "sensor-puerta-01", "entrada", 4, HIGH, HIGH, 0 },
  // { "contacto-02", "sala",     16, HIGH, HIGH, 0 },
  // { "contacto-03", "cocina",   17, HIGH, HIGH, 0 },
  // { "contacto-04", "recamara", 21, HIGH, HIGH, 0 },
};
const int NUM_CONTACTOS = USAR_SENSORES_LOCALES ? (int)(sizeof(contactos) / sizeof(contactos[0])) : 0;

/*
 * Sensores de movimiento AM312. Alimentacion 3.3 V, GND y OUT al pin.
 * Pines recomendados: 18, 19, 25, 26, 27. El GPIO 5 NO sirve: es un pin de
 * arranque y da lecturas falsas.
 */
struct Pir {
  const char* sensorId;
  const char* zona;
  int pin;
  volatile bool pulso;     // lo levanta la interrupcion
  unsigned long tUltimo;   // ultimo evento aceptado
  int previa;              // lectura anterior, para detectar el flanco por sondeo
};

Pir pirs[] = {
  { "pir-sala-01", "sala", 18, false, 0 },
  // { "pir-02", "pasillo", 19, false, 0 },
};
const int NUM_PIRS = USAR_SENSORES_LOCALES ? (int)(sizeof(pirs) / sizeof(pirs[0])) : 0;

// ===================== Tipos del protocolo ESP-NOW =====================
// Se definen aqui, antes de cualquier funcion, porque el Arduino IDE genera los
// prototipos de las funciones al inicio del archivo y necesita conocer estos tipos.

// Debe ser IDENTICO en nodo_c3.ino
const uint8_t TIPO_EVENTO = 1;
const uint8_t TIPO_ESTADO = 2;
const uint8_t TIPO_HOLA   = 3;

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
};

struct OrigenRemoto { uint8_t mac[6]; uint32_t ultimaSecuencia; bool usado; };
struct EstadoRemoto { char sensorId[24]; int valor; bool usado; };


// ===================== Parametros de procesamiento =====================

const unsigned long DEBOUNCE_MS   = 50;     // filtrado de rebote del contacto
const unsigned long BLOQUEO_PIR_MS = 8000;  // espera minima entre eventos de movimiento
// El AM312 necesita entre 30 y 60 s tras energizarse para estabilizarse. Durante
// ese tiempo sus lecturas no son confiables y se ignoran.
const unsigned long PIR_ESTABILIZACION_MS = 45000;
const unsigned long INTERVALO_ESTADO_MS = 2000;
const unsigned long TIMEOUT_HTTP_MS = 5000;
const unsigned long INTERVALO_RECONEXION_MS = 10000;
const int  MAX_REINTENTOS   = 3;
const int  CAPACIDAD_BUFFER = 20;

// Tiempo maximo que suena la alarma si nadie la apaga, en milisegundos
const unsigned long DURACION_SIRENA_MS = 30000;

// La salida parpadea para simular el sonido de una sirena. Con un LED se ve
// como encendido y apagado. Con un relevador y una sirena real conviene poner
// SALIDA_INTERMITENTE en false para que suene de forma continua.
const bool SALIDA_INTERMITENTE = true;
const unsigned long INTERVALO_PARPADEO_MS = 300;
const unsigned long INTERVALO_REPORTE_ALARMA_MS = 1000;

// ===================== Estado interno =====================

bool pirListo = false;   // true cuando termino el tiempo de estabilizacion

// El AM312 mantiene su salida en alto solo unos 2 segundos. Si el programa esta
// ocupado en una peticion HTTP (que puede tardar hasta 5 s con el servidor
// caido), un sondeo podria perder el pulso por completo. Por eso el flanco de
// subida se captura con una interrupcion, que no depende de lo que haga el ciclo.
// Cada interrupcion recibe como argumento el indice de su sensor en "pirs".
void IRAM_ATTR alDetectarPir(void* arg) {
  pirs[(int)(intptr_t)arg].pulso = true;
}

unsigned long tUltimoEstado = 0;
unsigned long contadorRegistro = 0;

unsigned long enviosExitosos = 0;
unsigned long enviosFallidos = 0;

// Estado recibido del backend
bool sistemaArmado   = false;
bool modoSilencioso  = false;
bool salidaManual    = false;   // activacion directa desde la aplicacion

// Sirena disparada por un evento de alarma
bool sirenaPorAlarma = false;
unsigned long tInicioSirena = 0;

// Coordinacion con el backend. El nodo decide localmente para que la alarma
// suene aun sin Internet, y despues informa lo ocurrido.
bool alarmaReportadaActiva = false;   // ultimo valor que el backend conoce
bool alarmaConfirmada = false;        // el backend ya vio esta alarma como activa
char motivoAlarma[20] = "";           // variable que disparo la alarma, para el aviso
char zonaAlarma[20]   = "";
char sensorAlarma[24] = "";
char nodoAlarma[16]   = "";           // nodo que reporto el sensor que disparo           // sensor que disparo, para resaltarlo en la app
unsigned long tUltimoReporteAlarma = 0;

bool wifiEstabaConectado = false;
unsigned long tUltimoIntentoWiFi = 0;

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

WiFiClient clienteRed;

// Declaraciones adelantadas, porque se usan antes de su definicion
bool enviarAlarma(bool activa, bool silenciosa);
void iniciarEspNow();

// ===================== Wi-Fi no bloqueante =====================

/*
 * Nunca detiene el programa. Una version anterior esperaba la conexion dentro
 * de un ciclo que bloqueaba hasta quince segundos, y durante esa espera el
 * sensor no se leia, justo cuando mas importa que siga funcionando.
 */
void atenderWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiEstabaConectado) {
      Serial.print("[WiFi] Conectado. IP: ");
      Serial.println(WiFi.localIP());
      wifiEstabaConectado = true;
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
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    tUltimoIntentoWiFi = millis();
  }
}

void iniciarWiFi() {
  Serial.print("[WiFi] Iniciando conexion a ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  iniciarEspNow();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  tUltimoIntentoWiFi = millis();
}

// ===================== Envio de mediciones =====================

bool enviarMedicion(unsigned long numeroRegistro, const char* variable,
                    const char* zona, const char* sensorId, const char* nodoId,
                    int valor, long &latenciaMs) {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(BACKEND_BASE) + "/mediciones";

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.begin(clienteRed, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);

  JsonDocument doc;
  doc["vivienda_id"]     = VIVIENDA_ID;
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

  return (codigo == 201);
}

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
  if (eventosEnBuffer == 0 || WiFi.status() != WL_CONNECTED) return;

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

// ===================== Logica de alarma =====================

/*
 * Decide que hacer con un evento confirmado.
 *
 * La salida audible solo se activa cuando el sistema esta armado, el evento
 * corresponde a una condicion de alarma y el modo silencioso esta desactivado.
 * El registro y el envio ocurren siempre, incluso en modo silencioso, porque
 * lo que el modo silencioso suprime es el ruido, no la evidencia.
 */
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
    if (modoSilencioso) {
      Serial.println("   ALARMA en modo silencioso. Se registra y se notifica sin activar la salida.");
      strncpy(motivoAlarma, variable, sizeof(motivoAlarma) - 1); motivoAlarma[sizeof(motivoAlarma) - 1] = '\0';
      strncpy(zonaAlarma, zona, sizeof(zonaAlarma) - 1);         zonaAlarma[sizeof(zonaAlarma) - 1] = '\0';
      strncpy(sensorAlarma, sensorId, sizeof(sensorAlarma) - 1); sensorAlarma[sizeof(sensorAlarma) - 1] = '\0';
      strncpy(nodoAlarma, nodoId, sizeof(nodoAlarma) - 1);       nodoAlarma[sizeof(nodoAlarma) - 1] = '\0';
      // Un solo intento. El evento ya queda registrado como medicion, y este
      // aviso solo sirve para la notificacion.
      enviarAlarma(true, true);
    } else {
      Serial.println("   ALARMA. Se activa la salida audible.");
      if (!sirenaPorAlarma) {
        // Alarma nueva. Todavia no la conoce el backend.
        alarmaConfirmada = false;
        alarmaReportadaActiva = false;
      }
      strncpy(motivoAlarma, variable, sizeof(motivoAlarma) - 1); motivoAlarma[sizeof(motivoAlarma) - 1] = '\0';
      strncpy(zonaAlarma, zona, sizeof(zonaAlarma) - 1);         zonaAlarma[sizeof(zonaAlarma) - 1] = '\0';
      strncpy(sensorAlarma, sensorId, sizeof(sensorAlarma) - 1); sensorAlarma[sizeof(sensorAlarma) - 1] = '\0';
      strncpy(nodoAlarma, nodoId, sizeof(nodoAlarma) - 1);       nodoAlarma[sizeof(nodoAlarma) - 1] = '\0';
      sirenaPorAlarma = true;
      tInicioSirena = millis();
    }
  } else if (esAlarma) {
    Serial.println("   Sistema desarmado. Solo se registra el evento.");
  }

  bool enviado = false;
  long latencia = 0;

  if (WiFi.status() != WL_CONNECTED) {
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

/*
 * Avisa al backend de una alarma. Con silenciosa = true el aviso es solo para
 * que se notifique, porque no hay sirena que apagar despues.
 * Devuelve true si el backend respondio correctamente.
 */
bool enviarAlarma(bool activa, bool silenciosa) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.begin(clienteRed, String(BACKEND_BASE) + "/alarma");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);

  JsonDocument doc;
  doc["vivienda_id"] = VIVIENDA_ID;
  doc["nodo_id"]     = nodoAlarma[0] ? nodoAlarma : NODO_ID;
  doc["activa"]      = activa;
  if (activa) {
    doc["motivo"]    = motivoAlarma;
    doc["zona"]      = zonaAlarma;
    doc["sensor_id"] = sensorAlarma;
    doc["silenciosa"] = silenciosa;
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

bool reportarAlarma(bool activa) {
  return enviarAlarma(activa, false);
}

/*
 * Mantiene al backend al tanto de si la alarma esta sonando. Si no hay
 * conexion, el aviso queda pendiente y se reintenta despues.
 */
void sincronizarAlarma() {
  if (alarmaReportadaActiva == sirenaPorAlarma) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() - tUltimoReporteAlarma < INTERVALO_REPORTE_ALARMA_MS) return;

  tUltimoReporteAlarma = millis();
  if (reportarAlarma(sirenaPorAlarma)) alarmaReportadaActiva = sirenaPorAlarma;
}

void apagarAlarmaLocal(const char* motivo) {
  if (!sirenaPorAlarma) return;
  sirenaPorAlarma = false;
  alarmaConfirmada = false;
  Serial.print("[Alarma] Apagada. Motivo: ");
  Serial.println(motivo);
}

/*
 * Consulta el estado de armado en el backend.
 * Se usa consulta periodica porque sobre HTTP no existe un canal permanente
 * hacia el dispositivo. En el prototipo alfa se sustituye por MQTT, donde el
 * servidor si puede avisar en el momento en que ocurre el cambio.
 */
void consultarEstado() {
  if (WiFi.status() != WL_CONNECTED) return;

  String url = String(BACKEND_BASE) + "/estado?vivienda_id=" + VIVIENDA_ID;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.begin(clienteRed, url);
  int codigo = http.GET();

  if (codigo == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {
      bool armadoAntes = sistemaArmado;
      sistemaArmado  = doc["armado"]          | false;
      modoSilencioso = doc["modo_silencioso"] | false;
      salidaManual   = doc["actuador_activo"] | false;
      bool alarmaRemota = doc["alarma_activa"] | false;

      if (armadoAntes != sistemaArmado) {
        Serial.print("[Estado] El sistema quedo ");
        Serial.println(sistemaArmado ? "ARMADO" : "DESARMADO");
      }

      if (sirenaPorAlarma) {
        // Al desarmar, la alarma se apaga de inmediato
        if (!sistemaArmado) {
          apagarAlarmaLocal("el sistema se desarmo");
        } else if (alarmaRemota) {
          alarmaConfirmada = true;
        } else if (alarmaConfirmada) {
          // El backend la conocia como activa y ahora ya no: la apagaron
          // desde la aplicacion. Si aun no la conocia, es un desfase normal
          // porque el aviso todavia no llego, y no se debe apagar.
          apagarAlarmaLocal("apagada desde la aplicacion");
        }
      }
    }
  }
  http.end();
}

/*
 * La salida se activa por dos motivos independientes: una alarma en curso, o
 * una activacion manual desde la aplicacion para probar la sirena.
 * Mientras esta activa parpadea, para simular el sonido de una sirena.
 */
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
}

// ===================== Recepcion de nodos perifericos (ESP-NOW) =====================

// La funcion de recepcion corre en la tarea de Wi-Fi, no en el ciclo principal.
// Solo copia el paquete a una cola; el ciclo lo procesa cuando puede, porque
// procesar un evento hace peticiones HTTP que pueden tardar varios segundos.
const int CAP_COLA_RX = 8;
PaqueteSensor colaRx[CAP_COLA_RX];
uint8_t colaRxMac[CAP_COLA_RX][6];
volatile int rxEscribir = 0;
volatile int rxLeer = 0;

void guardarPaqueteRx(const uint8_t* mac, const uint8_t* datos, int largo) {
  if (largo != (int)sizeof(PaqueteSensor)) return;
  const PaqueteSensor* p = (const PaqueteSensor*)datos;
  if (p->magia[0] != 'S' || p->magia[1] != 'R' || p->version != 1) return;
  int sig = (rxEscribir + 1) % CAP_COLA_RX;
  if (sig == rxLeer) return;   // cola llena: el nodo periferico reintentara
  memcpy(&colaRx[rxEscribir], datos, sizeof(PaqueteSensor));
  memcpy(colaRxMac[rxEscribir], mac, 6);
  rxEscribir = sig;
}

// La firma de la funcion de recepcion cambio en IDF 5 (core ESP32 3.x)
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
void alRecibirEspNow(const esp_now_recv_info_t* info, const uint8_t* datos, int largo) {
  guardarPaqueteRx(info->src_addr, datos, largo);
}
#else
void alRecibirEspNow(const uint8_t* mac, const uint8_t* datos, int largo) {
  guardarPaqueteRx(mac, datos, largo);
}
#endif

// Los reintentos del nodo periferico llegan con el mismo numero de secuencia.
// Se descartan comparando con el ultimo aceptado de cada origen.
OrigenRemoto origenes[4];

bool esDuplicado(const uint8_t* mac, uint32_t secuencia) {
  for (int i = 0; i < 4; i++) {
    if (origenes[i].usado && memcmp(origenes[i].mac, mac, 6) == 0) {
      if (origenes[i].ultimaSecuencia == secuencia) return true;
      origenes[i].ultimaSecuencia = secuencia;
      return false;
    }
  }
  for (int i = 0; i < 4; i++) {
    if (!origenes[i].usado) {
      origenes[i].usado = true;
      memcpy(origenes[i].mac, mac, 6);
      origenes[i].ultimaSecuencia = secuencia;
      return false;
    }
  }
  return false;   // tabla llena: se acepta sin deduplicar
}

// Ultimo estado conocido de cada sensor remoto, para registrar el primero sin
// disparar alarma y detectar cambios perdidos.
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

void procesarPaqueteRemoto(PaqueteSensor &p, const uint8_t* mac) {
  if (p.tipo == TIPO_HOLA) return;

  // Se garantiza el fin de cada texto antes de usarlo
  p.nodoId[sizeof(p.nodoId) - 1] = '\0';
  p.sensorId[sizeof(p.sensorId) - 1] = '\0';
  p.variable[sizeof(p.variable) - 1] = '\0';
  p.zona[sizeof(p.zona) - 1] = '\0';

  bool esContacto = strcmp(p.variable, "estado_puerta") == 0;
  bool esMovimiento = strcmp(p.variable, "movimiento") == 0;
  if (!esContacto && !esMovimiento) return;
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
    EstadoRemoto* e = esContacto ? buscarEstado(p.sensorId) : nullptr;
    if (esContacto) {
      if (e) e->valor = p.valor; else crearEstado(p.sensorId, p.valor);
    }
    procesarEvento(p.variable, p.zona, p.sensorId, p.nodoId, p.valor, p.valor == 1);
    return;
  }

  if (p.tipo == TIPO_ESTADO) {
    EstadoRemoto* e = buscarEstado(p.sensorId);
    if (!e) {
      // Primera vez que se ve este sensor: se registra sin activar alarma
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
    memcpy(&p, &colaRx[rxLeer], sizeof(p));
    memcpy(mac, colaRxMac[rxLeer], 6);
    rxLeer = (rxLeer + 1) % CAP_COLA_RX;
    procesarPaqueteRemoto(p, mac);
  }
}

// Lee la MAC directo del chip. WiFi.macAddress() puede devolver ceros si se
// llama antes de que el Wi-Fi termine de arrancar.
void imprimirMac(const char* etiqueta) {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char texto[18];
  snprintf(texto, sizeof(texto), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.print(etiqueta);
  Serial.println(texto);
}

void iniciarEspNow() {
  imprimirMac("[MAC] Esta placa (nodo receptor): ");

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] No se pudo iniciar. No se recibiran nodos perifericos.");
    return;
  }
  if (USAR_CIFRADO) {
    esp_now_set_pmk((const uint8_t*)CLAVE_PMK);
    esp_now_peer_info_t par = {};
    memcpy(par.peer_addr, MAC_C3, 6);
    par.channel = 0;
    par.ifidx = WIFI_IF_STA;
    par.encrypt = true;
    memcpy(par.lmk, CLAVE_LMK, 16);
    if (esp_now_add_peer(&par) != ESP_OK) Serial.println("[ESP-NOW] No se pudo registrar el nodo C3 cifrado.");
  }
  esp_now_register_recv_cb(alRecibirEspNow);
  Serial.println("[ESP-NOW] Escuchando nodos perifericos.");
}

// ===================== setup / loop =====================

void setup() {
  Serial.begin(115200);
  delay(300);

  for (int i = 0; i < NUM_CONTACTOS; i++) {
    pinMode(contactos[i].pin, INPUT_PULLUP);
  }
  // Entrada simple, igual que en el sketch de prueba que si funciono. El AM312
  // maneja su salida activamente, asi que no necesita resistencias internas.
  for (int i = 0; i < NUM_PIRS; i++) {
    pinMode(pirs[i].pin, INPUT);
  }
  pinMode(PIN_SALIDA, OUTPUT);
  digitalWrite(PIN_SALIDA, LOW);

  for (int i = 0; i < NUM_CONTACTOS; i++) {
    contactos[i].estable = digitalRead(contactos[i].pin);
    contactos[i].previa  = contactos[i].estable;
  }

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Nodo sensor - Sistema de seguridad");
  Serial.print(" Vivienda: "); Serial.println(VIVIENDA_ID);
  Serial.print(" Nodo:     "); Serial.println(NODO_ID);
  Serial.println(USAR_SENSORES_LOCALES ? " Sensores locales:" : " Sensores locales: desactivados (los aporta el nodo C3 por ESP-NOW)");
  for (int i = 0; i < NUM_CONTACTOS; i++) {
    Serial.print("   contacto  "); Serial.print(contactos[i].sensorId);
    Serial.print(" (GPIO "); Serial.print(contactos[i].pin); Serial.print(", ");
    Serial.print(contactos[i].zona); Serial.println(")");
  }
  for (int i = 0; i < NUM_PIRS; i++) {
    Serial.print("   movimiento "); Serial.print(pirs[i].sensorId);
    Serial.print(" (GPIO "); Serial.print(pirs[i].pin); Serial.print(", ");
    Serial.print(pirs[i].zona); Serial.println(")");
  }
  Serial.println("==========================================");

  // El AM312 necesita estabilizarse tras el encendido antes de ser fiable
  if (NUM_PIRS > 0) {
    Serial.print("[PIR] Estabilizando el sensor durante ");
    Serial.print(PIR_ESTABILIZACION_MS / 1000);
    Serial.println(" s. Sus lecturas se ignoran hasta entonces.");
  }

  iniciarWiFi();
}

void loop() {
  // ---- Contactos magneticos, con filtrado de rebote ----
  for (int i = 0; i < NUM_CONTACTOS; i++) {
    Contacto &c = contactos[i];
    int lectura = digitalRead(c.pin);

    if (lectura != c.previa) {
      c.tCambio = millis();
      c.previa = lectura;
    }

    if ((millis() - c.tCambio) > DEBOUNCE_MS && lectura != c.estable) {
      c.estable = lectura;
      // Con pull-up: circuito abierto significa que el iman se separo, o sea
      // que la puerta o ventana se abrio. Esa es la condicion de alarma.
      int valor = (c.estable == HIGH) ? 1 : 0;
      procesarEvento("estado_puerta", c.zona, c.sensorId, NODO_ID, valor, valor == 1);
    }
  }

  // ---- Sensores de movimiento ----
  if (NUM_PIRS > 0) {
    if (!pirListo) {
      // Se ignora durante la estabilizacion. Las interrupciones se activan hasta
      // que termina, para que el arranque del sensor no cuente como evento.
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
        // Respaldo por sondeo: si la interrupcion no llegara a dispararse, el
        // flanco de subida se detecta igual leyendo el pin en cada ciclo.
        int lect = digitalRead(p.pin);
        if (lect == HIGH && p.previa == LOW) p.pulso = true;
        p.previa = lect;
        if (!p.pulso) continue;
        p.pulso = false;
        Serial.print("[PIR] Pulso detectado en ");
        Serial.println(p.sensorId);

        // Bloqueo posterior para no inundar de eventos mientras alguien
        // permanece en la habitacion
        if (p.tUltimo == 0 || millis() - p.tUltimo > BLOQUEO_PIR_MS) {
          p.tUltimo = millis();
          procesarEvento("movimiento", p.zona, p.sensorId, NODO_ID, 1, true);
        } else {
          Serial.println("   Ignorado por el bloqueo entre eventos de movimiento.");
        }
      }
    }
  }

  // ---- Eventos recibidos de los nodos perifericos por ESP-NOW ----
  atenderRemotos();

  // ---- Red y sincronizacion, sin detener el ciclo ----
  atenderWiFi();
  if (WiFi.status() == WL_CONNECTED) intentarVaciarBuffer();

  // ---- Consulta periodica del estado de armado ----
  if (millis() - tUltimoEstado > INTERVALO_ESTADO_MS) {
    tUltimoEstado = millis();
    consultarEstado();
  }

  actualizarSalida();
  sincronizarAlarma();

  delay(10);
}
