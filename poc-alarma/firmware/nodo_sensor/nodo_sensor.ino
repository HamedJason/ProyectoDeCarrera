/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Nodo sensor sobre ESP32 DevKit
 *
 * Cadena demostrada por este firmware:
 *   entrada fisica -> procesamiento local -> Wi-Fi -> POST al backend
 *                                                  -> consulta de estado
 *                                                  -> salida audible
 *
 * Entradas soportadas:
 *   - Contacto magnetico MC-38 en una puerta o ventana (contacto seco)
 *   - Sensor infrarrojo pasivo AM312 para movimiento
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

// ===================== Hardware =====================

const int PIN_PUERTA = 4;   // contacto MC-38, con resistencia pull-up interna
const int PIN_PIR    = 5;   // salida del AM312, activa en alto
const int PIN_SALIDA = 2;   // LED integrado o entrada del relevador de la sirena

// Para usar solo uno de los dos sensores, poner el otro en false
const bool USAR_PUERTA = true;
const bool USAR_PIR    = true;

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

int  lecturaPuertaEstable = HIGH;
int  lecturaPuertaPrevia  = HIGH;
unsigned long tUltimoCambioPuerta = 0;

int  lecturaPirPrevia = LOW;
unsigned long tUltimoEventoPir = 0;
bool pirListo = false;   // true cuando termino el tiempo de estabilizacion

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
unsigned long tUltimoReporteAlarma = 0;

bool wifiEstabaConectado = false;
unsigned long tUltimoIntentoWiFi = 0;

struct EventoPendiente {
  unsigned long numeroRegistro;
  char          variable[20];
  char          zona[20];
  char          sensorId[24];
  int           valor;
};

EventoPendiente bufferEventos[CAPACIDAD_BUFFER];
int eventosEnBuffer = 0;

WiFiClient clienteRed;

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
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  tUltimoIntentoWiFi = millis();
}

// ===================== Envio de mediciones =====================

bool enviarMedicion(unsigned long numeroRegistro, const char* variable,
                    const char* zona, const char* sensorId, int valor,
                    long &latenciaMs) {
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
  doc["nodo_id"]         = NODO_ID;
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
                     const char* zona, const char* sensorId, int valor) {
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
    if (!enviarMedicion(e.numeroRegistro, e.variable, e.zona, e.sensorId, e.valor, lat)) break;
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
                    const char* sensorId, int valor, bool esAlarma) {
  contadorRegistro++;

  Serial.print("[Evento] registro=");
  Serial.print(contadorRegistro);
  Serial.print(" ");
  Serial.print(variable);
  Serial.print(" valor=");
  Serial.print(valor);
  Serial.print(" zona=");
  Serial.println(zona);

  if (esAlarma && sistemaArmado) {
    if (modoSilencioso) {
      Serial.println("   ALARMA en modo silencioso. Se registra sin activar la salida.");
    } else {
      Serial.println("   ALARMA. Se activa la salida audible.");
      if (!sirenaPorAlarma) {
        // Alarma nueva. Todavia no la conoce el backend.
        alarmaConfirmada = false;
        alarmaReportadaActiva = false;
      }
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
      enviado = enviarMedicion(contadorRegistro, variable, zona, sensorId, valor, latencia);
    }
  }

  if (enviado) {
    enviosExitosos++;
  } else {
    enviosFallidos++;
    guardarEnBuffer(contadorRegistro, variable, zona, sensorId, valor);
  }

  Serial.print("[Contadores] exitosos=");
  Serial.print(enviosExitosos);
  Serial.print(" fallidos=");
  Serial.println(enviosFallidos);
}

/*
 * Avisa al backend que la alarma empezo o termino.
 * Devuelve true si el backend respondio correctamente.
 */
bool reportarAlarma(bool activa) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.begin(clienteRed, String(BACKEND_BASE) + "/alarma");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);

  JsonDocument doc;
  doc["vivienda_id"] = VIVIENDA_ID;
  doc["nodo_id"]     = NODO_ID;
  doc["activa"]      = activa;
  String cuerpo;
  serializeJson(doc, cuerpo);

  int codigo = http.POST(cuerpo);
  http.end();

  Serial.print("[Alarma] Aviso al backend activa=");
  Serial.print(activa ? "true" : "false");
  Serial.print(" codigo=");
  Serial.println(codigo);

  return (codigo == 200);
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

// ===================== setup / loop =====================

void setup() {
  Serial.begin(115200);
  delay(300);

  if (USAR_PUERTA) pinMode(PIN_PUERTA, INPUT_PULLUP);
  // Pull-down interno: si el cable del sensor se desconecta, la lectura es 0
  // y no un valor flotante que dispare eventos falsos.
  if (USAR_PIR)    pinMode(PIN_PIR, INPUT_PULLDOWN);
  pinMode(PIN_SALIDA, OUTPUT);
  digitalWrite(PIN_SALIDA, LOW);

  if (USAR_PUERTA) {
    lecturaPuertaEstable = digitalRead(PIN_PUERTA);
    lecturaPuertaPrevia  = lecturaPuertaEstable;
  }

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Nodo sensor - Sistema de seguridad");
  Serial.print(" Vivienda: "); Serial.println(VIVIENDA_ID);
  Serial.print(" Nodo:     "); Serial.println(NODO_ID);
  Serial.print(" Sensores: ");
  if (USAR_PUERTA) Serial.print("puerta ");
  if (USAR_PIR)    Serial.print("movimiento");
  Serial.println();
  Serial.println("==========================================");

  // El AM312 necesita estabilizarse tras el encendido antes de ser fiable
  if (USAR_PIR) {
    Serial.print("[PIR] Estabilizando el sensor durante ");
    Serial.print(PIR_ESTABILIZACION_MS / 1000);
    Serial.println(" s. Sus lecturas se ignoran hasta entonces.");
  }

  iniciarWiFi();
}

void loop() {
  // ---- Contacto magnetico, con filtrado de rebote ----
  if (USAR_PUERTA) {
    int lectura = digitalRead(PIN_PUERTA);

    if (lectura != lecturaPuertaPrevia) {
      tUltimoCambioPuerta = millis();
      lecturaPuertaPrevia = lectura;
    }

    if ((millis() - tUltimoCambioPuerta) > DEBOUNCE_MS && lectura != lecturaPuertaEstable) {
      lecturaPuertaEstable = lectura;
      // Con pull-up: circuito abierto significa que el iman se separo, o sea
      // que la puerta se abrio. Esa es la condicion de alarma.
      int valor = (lecturaPuertaEstable == HIGH) ? 1 : 0;
      procesarEvento("estado_puerta", "entrada", "sensor-puerta-01", valor, valor == 1);
    }
  }

  // ---- Sensor de movimiento ----
  if (USAR_PIR) {
    if (!pirListo) {
      // Se ignora durante la estabilizacion. Al terminar se toma la lectura
      // actual como referencia, para no contar como evento un nivel alto que
      // ya estaba presente.
      if (millis() >= PIR_ESTABILIZACION_MS) {
        pirListo = true;
        lecturaPirPrevia = digitalRead(PIN_PIR);
        Serial.print("[PIR] Listo. Lectura inicial: ");
        Serial.println(lecturaPirPrevia);
      }
    } else {
      int lectura = digitalRead(PIN_PIR);

      // Solo interesa el flanco de subida, y con un bloqueo posterior para no
      // inundar de eventos mientras alguien permanece en la habitacion
      if (lectura == HIGH && lecturaPirPrevia == LOW &&
          millis() - tUltimoEventoPir > BLOQUEO_PIR_MS) {
        tUltimoEventoPir = millis();
        procesarEvento("movimiento", "sala", "pir-sala-01", 1, true);
      }
      lecturaPirPrevia = lectura;
    }
  }

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
