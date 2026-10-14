/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Nodo periferico sobre ESP32-C3
 *
 * No se conecta a Internet. Lee sus sensores y manda cada evento por ESP-NOW
 * al concentrador (nodo_sensor.ino), que decide si suena la alarma y avisa al
 * backend.
 *
 *   [MC-38 + AM312] -> ESP32-C3 --ESP-NOW--> concentrador --Wi-Fi--> backend
 *
 * EMPAREJAMIENTO AUTOMATICO
 *   No hay MAC ni canal escritos en el codigo. La primera vez, el C3 busca al
 *   concentrador en los canales 1 a 13 y le pide enlazarse; el concentrador
 *   responde si tiene abierto el comando "emparejar". El C3 guarda la MAC del
 *   concentrador en su flash y ya no vuelve a necesitarlo.
 *   Despues de un reinicio solo vuelve a buscar el canal (el del router).
 *
 * Comandos por el Monitor Serie (115200, "Nueva linea"): ver, olvidar,
 * reiniciar, ayuda.
 *
 * Si el concentrador esta apagado, los eventos esperan en una cola pequena.
 *
 * Conexiones (los pines se cambian abajo):
 *   MC-38:  un cable al GPIO 4 (y otro al 3) y el otro a GND, con pull-up interno
 *   AM312:  VCC a 3V3 (o 5V), GND a GND, VOUT al GPIO 5
 * Evitar en el C3 los pines 2, 8 y 9 (arranque) y 18 y 19 (USB).
 */

#include <WiFi.h>
#include <Preferences.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_idf_version.h>
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include <esp_mac.h>
#else
#include <esp_system.h>
#endif

// ===================== Configuracion =====================

// Para conservar los identificadores de un nodo ya registrado con el firmware
// anterior. Si no, dejalos vacios y el nodo se llama c3-xxxxxx con su MAC.
const char* NODO_ID_ANTIGUO = "";
const char* ID_PIR_ANTIGUO  = "";
const char* ZONA            = "";   // lugar del nodo, opcional (ej. "sala")

// Cada MC-38 va entre su pin y GND. "idAntiguo" es opcional.
struct ContactoCfg {
  int pin;
  const char* idAntiguo;
};
const ContactoCfg CONTACTOS[] = {
  { 4, "" },
  { 3, "" },
};
const int NUM_CONTACTOS = sizeof(CONTACTOS) / sizeof(CONTACTOS[0]);
const int MAX_CONTACTOS = 6;
const int PIN_PIR = 5;    // salida del AM312, activa en alto
const int PIN_LED = -1;   // LED de enlace opcional (-1 si no hay)

// Cifrado ESP-NOW opcional; debe coincidir con el concentrador. Las claves estan
// en el repositorio, asi que cambialas por otras de 16 caracteres si lo activas.
const bool USAR_CIFRADO = false;
const char* CLAVE_PMK = "pmk-uabc-2026-a1";
const char* CLAVE_LMK = "lmk-uabc-2026-b2";

// ===================== Parametros =====================

const unsigned long DEBOUNCE_MS = 50;
const unsigned long BLOQUEO_PIR_MS = 8000;
const unsigned long PIR_ESTABILIZACION_MS = 45000;   // el AM312 tarda 30-60 s en estabilizarse
const unsigned long INTERVALO_LATIDO_MS = 30000;     // reporta el contacto aunque no cambie
const unsigned long ESPERA_CONFIRMACION_MS = 80;
const unsigned long ESPERA_RESPUESTA_MS = 100;       // por canal, al pedir emparejarse
const int  REINTENTOS_ENVIO = 3;
const int  FALLOS_PARA_REBUSCAR = 3;
const unsigned long INTERVALO_BUSQUEDA_MS = 2000;

// ===================== Protocolo =====================
// Igual que en nodo_sensor.ino

const uint8_t TIPO_EVENTO    = 1;
const uint8_t TIPO_ESTADO    = 2;
const uint8_t TIPO_HOLA      = 3;
const uint8_t TIPO_EMPAREJAR = 4;
const uint8_t TIPO_RESPUESTA = 5;

struct __attribute__((packed)) PaqueteSensor {
  uint8_t  magia[2];      // 'S', 'R'
  uint8_t  version;
  uint8_t  tipo;
  uint32_t secuencia;
  char     nodoId[16];
  char     sensorId[24];
  char     variable[16];  // "estado_puerta" o "movimiento"
  char     zona[16];
  int8_t   valor;
};

const uint8_t MAC_BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

// ===================== Estado interno =====================

char NODO_ID[16];
char ID_PIR[24];
char contactoId[MAX_CONTACTOS][24];
char macPropia[13];   // MAC en hexadecimal sin separadores, para reconocer la respuesta

int  contactoEstable[MAX_CONTACTOS];
int  contactoPrevio[MAX_CONTACTOS];
unsigned long tCambioContacto[MAX_CONTACTOS];

volatile bool pirPulso = false;
bool pirListo = false;
int  pirPrevio = LOW;
unsigned long tUltimoPir = 0;

Preferences prefs;
uint8_t hubMac[6];          // MAC del concentrador, guardada al emparejar
bool hubGuardado = false;

bool enlazado = false;      // hay canal comun con el concentrador
int  fallosSeguidos = 0;
unsigned long tUltimaBusqueda = 0;
unsigned long tUltimoLatido = 0;
bool registroPirEnviado = false;
int  rondasEmparejar = 0;

uint32_t secuencia = 0;

// Resultado del ultimo envio, que llega en la funcion de confirmacion
volatile bool envioTerminado = false;
volatile bool envioOk = false;

// La respuesta del concentrador llega en la funcion de recepcion
volatile bool respuestaRecibida = false;
uint8_t macRespuesta[6];

const int CAP_COLA = 16;
PaqueteSensor cola[CAP_COLA];
int colaTam = 0;

String lineaSerie;

void IRAM_ATTR alDetectarPir() { pirPulso = true; }

String macATexto(const uint8_t* mac) {
  char t[18];
  snprintf(t, sizeof(t), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(t);
}

// Arma los identificadores a partir de la MAC del chip
void armarIdentificadores() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(macPropia, sizeof(macPropia), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

  char corto[8];
  snprintf(corto, sizeof(corto), "%02x%02x%02x", mac[3], mac[4], mac[5]);
  if (NODO_ID_ANTIGUO[0]) snprintf(NODO_ID, sizeof(NODO_ID), "%s", NODO_ID_ANTIGUO);
  else snprintf(NODO_ID, sizeof(NODO_ID), "c3-%s", corto);
  if (ID_PIR_ANTIGUO[0]) snprintf(ID_PIR, sizeof(ID_PIR), "%s", ID_PIR_ANTIGUO);
  else snprintf(ID_PIR, sizeof(ID_PIR), "%s-pir", NODO_ID);
  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    if (CONTACTOS[i].idAntiguo[0]) snprintf(contactoId[i], sizeof(contactoId[i]), "%s", CONTACTOS[i].idAntiguo);
    else snprintf(contactoId[i], sizeof(contactoId[i]), "%s-gpio%d", NODO_ID, CONTACTOS[i].pin);
  }
}

// ===================== ESP-NOW =====================

// La firma de las funciones de callback cambio con la version del core de ESP32
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
void alEnviar(const esp_now_send_info_t*, esp_now_send_status_t estado) {
#else
void alEnviar(const uint8_t*, esp_now_send_status_t estado) {
#endif
  envioOk = (estado == ESP_NOW_SEND_SUCCESS);
  envioTerminado = true;
}

// Solo interesa la respuesta de emparejamiento dirigida a esta placa
void procesarRecepcion(const uint8_t* mac, const uint8_t* datos, int largo) {
  if (hubGuardado || largo != (int)sizeof(PaqueteSensor)) return;
  const PaqueteSensor* p = (const PaqueteSensor*)datos;
  if (p->magia[0] != 'S' || p->magia[1] != 'R' || p->version != 1) return;
  if (p->tipo != TIPO_RESPUESTA) return;
  if (strncmp(p->variable, macPropia, 12) != 0) return;
  memcpy(macRespuesta, mac, 6);
  respuestaRecibida = true;
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
void alRecibir(const esp_now_recv_info_t* info, const uint8_t* datos, int largo) {
  procesarRecepcion(info->src_addr, datos, largo);
}
#else
void alRecibir(const uint8_t* mac, const uint8_t* datos, int largo) {
  procesarRecepcion(mac, datos, largo);
}
#endif

// Registra al concentrador como destino de los envios
bool registrarHub() {
  if (esp_now_is_peer_exist(hubMac)) esp_now_del_peer(hubMac);
  esp_now_peer_info_t par = {};
  memcpy(par.peer_addr, hubMac, 6);
  par.channel = 0;   // 0 = el canal actual, que cambia al buscar
  par.ifidx = WIFI_IF_STA;
  par.encrypt = USAR_CIFRADO;
  if (USAR_CIFRADO) memcpy(par.lmk, CLAVE_LMK, 16);
  return esp_now_add_peer(&par) == ESP_OK;
}

bool iniciarEspNow() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] No se pudo iniciar.");
    return false;
  }
  if (USAR_CIFRADO) esp_now_set_pmk((const uint8_t*)CLAVE_PMK);
  esp_now_register_send_cb(alEnviar);
  esp_now_register_recv_cb(alRecibir);

  // Par de broadcast, para pedir el emparejamiento
  esp_now_peer_info_t bc = {};
  memcpy(bc.peer_addr, MAC_BROADCAST, 6);
  bc.channel = 0;
  bc.ifidx = WIFI_IF_STA;
  bc.encrypt = false;
  esp_now_add_peer(&bc);

  if (hubGuardado && !registrarHub()) {
    Serial.println("[ESP-NOW] No se pudo registrar al concentrador.");
    return false;
  }
  return true;
}

void llenarPaquete(PaqueteSensor &p, uint8_t tipo, const char* sensorId,
                   const char* variable, const char* zona, int valor) {
  memset(&p, 0, sizeof(p));
  p.magia[0] = 'S';
  p.magia[1] = 'R';
  p.version = 1;
  p.tipo = tipo;
  p.secuencia = ++secuencia;
  strncpy(p.nodoId, NODO_ID, sizeof(p.nodoId) - 1);
  strncpy(p.sensorId, sensorId, sizeof(p.sensorId) - 1);
  strncpy(p.variable, variable, sizeof(p.variable) - 1);
  strncpy(p.zona, zona, sizeof(p.zona) - 1);
  p.valor = (int8_t)valor;
}

// Un envio con confirmacion. El unicast de ESP-NOW solo tiene exito si el
// concentrador contesta, por eso sirve tambien para saber si el canal es correcto.
bool enviarUnaVez(const PaqueteSensor &p) {
  envioTerminado = false;
  envioOk = false;
  if (esp_now_send(hubMac, (const uint8_t*)&p, sizeof(p)) != ESP_OK) return false;
  unsigned long t0 = millis();
  while (!envioTerminado && millis() - t0 < ESPERA_CONFIRMACION_MS) delay(1);
  return envioTerminado && envioOk;
}

// Con el concentrador ya conocido: prueba los canales 1 a 13 hasta que confirme
bool buscarCanal() {
  Serial.println("[Enlace] Buscando el canal del concentrador.");
  PaqueteSensor hola;
  for (int c = 1; c <= 13; c++) {
    esp_wifi_set_channel(c, WIFI_SECOND_CHAN_NONE);
    delay(5);
    llenarPaquete(hola, TIPO_HOLA, "-", "-", "-", 0);
    for (int i = 0; i < 2; i++) {
      if (enviarUnaVez(hola)) {
        Serial.print("[Enlace] Concentrador encontrado en el canal ");
        Serial.println(c);
        return true;
      }
    }
  }
  Serial.println("[Enlace] Sin respuesta del concentrador. Se reintenta.");
  return false;
}

// Sin concentrador guardado: pide emparejarse por broadcast en cada canal y
// espera la respuesta. Solo contesta un concentrador con "emparejar" abierto.
bool buscarEmparejamiento() {
  if (rondasEmparejar++ % 10 == 0) {
    Serial.println("[Emparejar] Buscando un concentrador. Escribe emparejar en el suyo.");
  }
  PaqueteSensor req;
  respuestaRecibida = false;
  for (int c = 1; c <= 13; c++) {
    esp_wifi_set_channel(c, WIFI_SECOND_CHAN_NONE);
    delay(5);
    llenarPaquete(req, TIPO_EMPAREJAR, "-", "-", "-", 0);
    esp_now_send(MAC_BROADCAST, (const uint8_t*)&req, sizeof(req));
    unsigned long t0 = millis();
    while (!respuestaRecibida && millis() - t0 < ESPERA_RESPUESTA_MS) delay(1);
    if (respuestaRecibida) return true;
  }
  return false;
}

void guardarHub() {
  memcpy(hubMac, macRespuesta, 6);
  prefs.putBytes("hub", hubMac, 6);
  hubGuardado = true;
  registrarHub();
  Serial.print("[Emparejar] Enlazado con el concentrador ");
  Serial.println(macATexto(hubMac));
}

// ===================== Cola de envio =====================

void encolar(const PaqueteSensor &p) {
  if (colaTam >= CAP_COLA) {
    // Llena: se descarta el mas antiguo para conservar lo reciente
    for (int i = 1; i < CAP_COLA; i++) cola[i - 1] = cola[i];
    colaTam = CAP_COLA - 1;
    Serial.println("[Cola] Llena. Se descarta el evento mas antiguo.");
  }
  cola[colaTam++] = p;
}

void vaciarCola() {
  while (colaTam > 0 && enlazado) {
    bool ok = false;
    for (int i = 0; i < REINTENTOS_ENVIO && !ok; i++) ok = enviarUnaVez(cola[0]);

    if (!ok) {
      if (++fallosSeguidos >= FALLOS_PARA_REBUSCAR) {
        Serial.println("[Enlace] Se perdio el enlace. Se buscara de nuevo el canal.");
        enlazado = false;
        registroPirEnviado = false;
      }
      return;
    }

    fallosSeguidos = 0;
    Serial.print("[Envio] ");
    Serial.print(cola[0].tipo == TIPO_EVENTO ? "evento " : "estado ");
    Serial.print(cola[0].sensorId);
    Serial.print(" valor=");
    Serial.println(cola[0].valor);
    for (int i = 1; i < colaTam; i++) cola[i - 1] = cola[i];
    colaTam--;
  }
}

// ===================== Consola serie =====================

void mostrarEstado() {
  Serial.println("---------- Estado ----------");
  Serial.print("Nodo:         "); Serial.println(NODO_ID);
  Serial.print("MAC:          ");
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  Serial.println(macATexto(mac));
  Serial.print("Concentrador: ");
  Serial.println(hubGuardado ? macATexto(hubMac) : String("sin emparejar"));
  Serial.print("Enlace:       "); Serial.println(enlazado ? "activo" : "buscando");
  Serial.print("En cola:      "); Serial.println(colaTam);
  Serial.println("----------------------------");
}

void ejecutarComando(String linea) {
  linea.trim();
  linea.toLowerCase();
  if (linea.length() == 0) return;

  if (linea == "ver") {
    mostrarEstado();
  } else if (linea == "olvidar" || linea == "emparejar") {
    if (hubGuardado && esp_now_is_peer_exist(hubMac)) esp_now_del_peer(hubMac);
    prefs.remove("hub");
    hubGuardado = false;
    enlazado = false;
    rondasEmparejar = 0;
    Serial.println("Concentrador olvidado. Escribe emparejar en el concentrador.");
  } else if (linea == "reiniciar") {
    ESP.restart();
  } else if (linea == "ayuda" || linea == "help" || linea == "?") {
    Serial.println("Comandos: ver, olvidar (volver a emparejar), reiniciar");
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
    } else if (lineaSerie.length() < 100) {
      lineaSerie += c;
    }
  }
}

void indicarLed(bool encendido) {
  if (PIN_LED >= 0) digitalWrite(PIN_LED, encendido ? HIGH : LOW);
}

// ===================== setup / loop =====================

void setup() {
  Serial.begin(115200);
  delay(300);

  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    pinMode(CONTACTOS[i].pin, INPUT_PULLUP);
  }
  // Entrada simple para el AM312: su salida es debil y un pull-down interno
  // la dejaria en un nivel intermedio
  pinMode(PIN_PIR, INPUT);
  if (PIN_LED >= 0) pinMode(PIN_LED, OUTPUT);

  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    contactoEstable[i] = digitalRead(CONTACTOS[i].pin);
    contactoPrevio[i] = contactoEstable[i];
    tCambioContacto[i] = 0;
  }

  secuencia = esp_random();   // evita repetir numeros tras un reinicio
  armarIdentificadores();

  prefs.begin("nodo", false);
  if (prefs.getBytesLength("hub") == 6) {
    prefs.getBytes("hub", hubMac, 6);
    hubGuardado = true;
  }

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Nodo periferico ESP32-C3");
  Serial.print(" Nodo: "); Serial.println(NODO_ID);
  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    Serial.print(" Contacto "); Serial.print(contactoId[i]);
    Serial.print(": GPIO "); Serial.println(CONTACTOS[i].pin);
  }
  Serial.print(" PIR "); Serial.print(ID_PIR); Serial.print(": GPIO "); Serial.println(PIN_PIR);
  Serial.println("==========================================");

  if (!iniciarEspNow()) {
    Serial.println("Reiniciando en 5 s.");
    delay(5000);
    ESP.restart();
  }
  Serial.print("[MAC] Esta placa: ");
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  Serial.println(macATexto(mac));
  Serial.println(hubGuardado ? "[Emparejar] Concentrador guardado: " + macATexto(hubMac)
                             : String("[Emparejar] Sin concentrador. Se buscara uno al emparejar."));

  Serial.print("[PIR] Estabilizando el sensor durante ");
  Serial.print(PIR_ESTABILIZACION_MS / 1000);
  Serial.println(" s. Sus lecturas se ignoran hasta entonces.");
}

void loop() {
  unsigned long ahora = millis();
  atenderConsola();

  // Contactos magneticos con filtrado de rebote
  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    int lectura = digitalRead(CONTACTOS[i].pin);
    if (lectura != contactoPrevio[i]) {
      tCambioContacto[i] = ahora;
      contactoPrevio[i] = lectura;
    }
    if ((ahora - tCambioContacto[i]) > DEBOUNCE_MS && lectura != contactoEstable[i]) {
      contactoEstable[i] = lectura;
      int valor = (lectura == HIGH) ? 1 : 0;   // abierto = 1
      Serial.print("[Contacto] ");
      Serial.print(contactoId[i]);
      Serial.println(valor ? " ABIERTO" : " CERRADO");
      PaqueteSensor p;
      llenarPaquete(p, TIPO_EVENTO, contactoId[i], "estado_puerta", ZONA, valor);
      encolar(p);
    }
  }

  // Sensor de movimiento
  if (!pirListo) {
    if (ahora >= PIR_ESTABILIZACION_MS) {
      pirListo = true;
      pirPulso = false;
      pirPrevio = digitalRead(PIN_PIR);
      attachInterrupt(digitalPinToInterrupt(PIN_PIR), alDetectarPir, RISING);
      Serial.print("[PIR] Listo en GPIO ");
      Serial.print(PIN_PIR);
      Serial.print(". Lectura inicial: ");
      Serial.println(pirPrevio);
    }
  } else {
    // Respaldo por sondeo por si la interrupcion no se dispara
    int lp = digitalRead(PIN_PIR);
    if (lp == HIGH && pirPrevio == LOW) pirPulso = true;
    pirPrevio = lp;

    if (pirPulso) {
      pirPulso = false;
      Serial.println("[PIR] Pulso detectado");
      if (tUltimoPir == 0 || ahora - tUltimoPir > BLOQUEO_PIR_MS) {
        tUltimoPir = ahora;
        PaqueteSensor p;
        llenarPaquete(p, TIPO_EVENTO, ID_PIR, "movimiento", ZONA, 1);
        encolar(p);
      } else {
        Serial.println("   Ignorado por el bloqueo entre eventos de movimiento.");
      }
    }
  }

  // Enlace con el concentrador
  if (!enlazado && ahora - tUltimaBusqueda > INTERVALO_BUSQUEDA_MS) {
    tUltimaBusqueda = ahora;
    if (!hubGuardado) {
      if (buscarEmparejamiento()) {
        guardarHub();
        enlazado = true;
      }
    } else {
      enlazado = buscarCanal();
    }
    fallosSeguidos = 0;
    if (enlazado) tUltimoLatido = 0;   // reporta el estado enseguida
  }

  // Estado periodico: registra los sensores y corrige eventos perdidos
  if (enlazado && (tUltimoLatido == 0 || ahora - tUltimoLatido > INTERVALO_LATIDO_MS)) {
    tUltimoLatido = ahora ? ahora : 1;
    PaqueteSensor p;
    for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
      llenarPaquete(p, TIPO_ESTADO, contactoId[i], "estado_puerta", ZONA,
                    contactoEstable[i] == HIGH ? 1 : 0);
      encolar(p);
    }
    if (!registroPirEnviado && pirListo) {
      llenarPaquete(p, TIPO_ESTADO, ID_PIR, "movimiento", ZONA, 0);
      encolar(p);
      registroPirEnviado = true;
    }
  }

  vaciarCola();
  indicarLed(enlazado);
  delay(5);
}
