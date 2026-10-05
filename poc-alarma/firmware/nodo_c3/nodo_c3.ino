/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Nodo periferico sobre ESP32-C3
 *
 * Este nodo NO se conecta a Internet ni al backend. Solo lee sus sensores y
 * manda cada evento por ESP-NOW al ESP32 "nodo receptor" (nodo_sensor.ino),
 * que decide si suena la alarma y avisa al backend.
 *
 *   [MC-38 + AM312] -> ESP32-C3 --ESP-NOW--> ESP32 receptor --Wi-Fi--> backend
 *
 * Por que ESP-NOW: es un enlace directo entre placas ESP32, sin router, con
 * confirmacion de entrega y latencia de pocos milisegundos.
 *
 * Detalle importante del canal: ESP-NOW solo funciona si las dos placas estan
 * en el mismo canal de radio. El receptor usa el canal de tu router, que no
 * se conoce de antemano, asi que este nodo lo busca solo: prueba los canales
 * 1 a 13 hasta que el receptor confirma la entrega. Si el canal cambia (por
 * ejemplo el router se reinicia), vuelve a buscarlo.
 *
 * Si el receptor esta apagado, los eventos se guardan en una cola pequena y se
 * envian cuando vuelva.
 *
 * Conexiones (ESP32-C3, los pines se pueden cambiar abajo):
 *   MC-38:  un cable al GPIO 4 y el otro a GND (pull-up interno)
 *   AM312:  VCC al pin 3V3 (o 5V), GND a GND, VOUT al GPIO 5
 * Evitar en el C3 los pines de arranque 2, 8 y 9, y el 18 y 19 (USB).
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_idf_version.h>
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include <esp_mac.h>
#else
#include <esp_system.h>
#endif

// ===================== Configuracion editable =====================

// Direccion MAC del ESP32 receptor. La imprime en el Serial al arrancar, en la
// linea "[MAC] Esta placa (nodo receptor): AA:BB:CC:DD:EE:FF". Copiala aqui.
uint8_t MAC_RECEPTOR[6] = { 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF };

// ---- Identificacion AUTOMATICA ----
// El nodo se identifica solo con los ultimos 3 bytes de su MAC, por ejemplo
// "c3-a1b2c3", y sus sensores como "c3-a1b2c3-gpio4" o "c3-a1b2c3-pir". No hay
// que escribir ningun identificador: al encenderlo, la aplicacion lo descubre
// y muestra los sensores con la etiqueta "Nuevo". Ahi se les pone nombre y se
// elige si son puerta o ventana.
//
// Solo para conservar los identificadores de un nodo que ya estaba registrado
// con el firmware anterior, escribe aqui el identificador antiguo (si no, "").
const char* NODO_ID_ANTIGUO = "";      // p. ej. "nodo-c3-01"
const char* ID_PIR_ANTIGUO  = "";      // p. ej. "pir-sala-01"
const char* ZONA            = "";      // opcional: lugar del nodo (ej. "sala")

// Contactos magneticos (MC-38). Cada uno va entre su pin y GND, con pull-up
// interno. Para agregar otro basta con anadir su pin.
// "idAntiguo" es opcional (""): para conservar un sensor ya registrado.
struct ContactoCfg {
  int pin;
  const char* idAntiguo;
};
const ContactoCfg CONTACTOS[] = {
  { 4, "" },     // p. ej. { 4, "sensor-puerta-01" } para conservar el historial
  { 3, "" },
};
const int NUM_CONTACTOS = sizeof(CONTACTOS) / sizeof(CONTACTOS[0]);
const int MAX_CONTACTOS = 6;
const int PIN_PIR      = 5;   // salida del AM312, activa en alto
const int PIN_LED      = -1;  // LED de estado opcional (-1 si no hay). Ej. 8 en algunas placas

// Cifrado ESP-NOW (opcional). Debe estar igual en el receptor, y ademas el
// receptor necesita la MAC de este nodo. Dejalo en false para la primera prueba.
const bool USAR_CIFRADO = false;
const char* CLAVE_PMK = "pmk-uabc-2026-a1";   // exactamente 16 caracteres
const char* CLAVE_LMK = "lmk-uabc-2026-b2";   // exactamente 16 caracteres

// ===================== Parametros =====================

const unsigned long DEBOUNCE_MS = 50;
const unsigned long BLOQUEO_PIR_MS = 8000;
const unsigned long PIR_ESTABILIZACION_MS = 45000;   // el AM312 tarda 30-60 s en estabilizarse
const unsigned long INTERVALO_LATIDO_MS = 30000;     // reporta el estado del contacto aunque no cambie
const unsigned long ESPERA_CONFIRMACION_MS = 80;
const int  REINTENTOS_ENVIO = 3;
const int  FALLOS_PARA_REBUSCAR = 3;
const unsigned long INTERVALO_BUSQUEDA_MS = 2000;

// ===================== Protocolo =====================
// Debe ser IDENTICO en nodo_sensor.ino (el receptor).

const uint8_t TIPO_EVENTO = 1;   // el sensor cambio o detecto algo
const uint8_t TIPO_ESTADO = 2;   // estado periodico, para registrar el sensor y corregir eventos perdidos
const uint8_t TIPO_HOLA   = 3;   // prueba de canal, el receptor lo ignora

struct __attribute__((packed)) PaqueteSensor {
  uint8_t  magia[2];      // 'S', 'R'
  uint8_t  version;       // 1
  uint8_t  tipo;
  uint32_t secuencia;
  char     nodoId[16];
  char     sensorId[24];
  char     variable[16];  // "estado_puerta" o "movimiento"
  char     zona[16];
  int8_t   valor;
};

// ===================== Estado interno =====================

// Identificadores resultantes (se arman en setup)
char NODO_ID[16];
char ID_PIR[24];
char contactoId[MAX_CONTACTOS][24];

int  contactoEstable[MAX_CONTACTOS];
int  contactoPrevio[MAX_CONTACTOS];
unsigned long tCambioContacto[MAX_CONTACTOS];

volatile bool pirPulso = false;
bool pirListo = false;
int  pirPrevio = LOW;
unsigned long tUltimoPir = 0;

bool enlazado = false;
int  canal = 0;
int  fallosSeguidos = 0;
unsigned long tUltimaBusqueda = 0;
unsigned long tUltimoLatido = 0;
bool registroPirEnviado = false;

uint32_t secuencia = 0;

// Resultado del ultimo envio, que llega en la funcion de confirmacion
volatile bool envioTerminado = false;
volatile bool envioOk = false;

const int CAP_COLA = 16;
PaqueteSensor cola[CAP_COLA];
int colaTam = 0;

void IRAM_ATTR alDetectarPir() { pirPulso = true; }

// Arma los identificadores a partir de la MAC del chip
void armarIdentificadores() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
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

// ===================== ESP-NOW =====================

// La firma de la funcion de confirmacion cambio con la version del core de
// ESP32 (IDF 5.5 en adelante). Como solo interesa si se entrego, se acepta
// cualquiera de las dos.
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
void alEnviar(const esp_now_send_info_t*, esp_now_send_status_t estado) {
#else
void alEnviar(const uint8_t*, esp_now_send_status_t estado) {
#endif
  envioOk = (estado == ESP_NOW_SEND_SUCCESS);
  envioTerminado = true;
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

  esp_now_peer_info_t par = {};
  memcpy(par.peer_addr, MAC_RECEPTOR, 6);
  par.channel = 0;   // 0 = el canal actual, que se cambia al buscar
  par.ifidx = WIFI_IF_STA;
  par.encrypt = USAR_CIFRADO;
  if (USAR_CIFRADO) memcpy(par.lmk, CLAVE_LMK, 16);
  if (esp_now_add_peer(&par) != ESP_OK) {
    Serial.println("[ESP-NOW] No se pudo registrar al receptor.");
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

// Un envio con confirmacion. ESP-NOW unicast devuelve exito solo si el
// receptor contesta, por eso sirve tambien para saber si el canal es correcto.
bool enviarUnaVez(const PaqueteSensor &p) {
  envioTerminado = false;
  envioOk = false;
  if (esp_now_send(MAC_RECEPTOR, (const uint8_t*)&p, sizeof(p)) != ESP_OK) return false;
  unsigned long t0 = millis();
  while (!envioTerminado && millis() - t0 < ESPERA_CONFIRMACION_MS) delay(1);
  return envioTerminado && envioOk;
}

// Prueba los canales 1 a 13 hasta que el receptor confirme una entrega
bool buscarCanal() {
  Serial.println("[Enlace] Buscando el canal del receptor.");
  PaqueteSensor hola;
  for (int c = 1; c <= 13; c++) {
    esp_wifi_set_channel(c, WIFI_SECOND_CHAN_NONE);
    delay(5);
    llenarPaquete(hola, TIPO_HOLA, "-", "-", "-", 0);
    for (int i = 0; i < 2; i++) {
      if (enviarUnaVez(hola)) {
        canal = c;
        Serial.print("[Enlace] Receptor encontrado en el canal ");
        Serial.println(c);
        return true;
      }
    }
  }
  Serial.println("[Enlace] Sin respuesta del receptor. Se reintenta.");
  return false;
}

// ===================== Cola de envio =====================

void encolar(const PaqueteSensor &p) {
  if (colaTam >= CAP_COLA) {
    // Cola llena: se descarta el mas antiguo para conservar lo reciente
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

// ===================== setup / loop =====================

void indicarLed(bool encendido) {
  if (PIN_LED >= 0) digitalWrite(PIN_LED, encendido ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);
  delay(300);

  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    pinMode(CONTACTOS[i].pin, INPUT_PULLUP);
  }
  // Entrada simple para el AM312: su salida es debil y un pull-down interno
  // la deja en un nivel intermedio.
  pinMode(PIN_PIR, INPUT);
  if (PIN_LED >= 0) pinMode(PIN_LED, OUTPUT);

  for (int i = 0; i < NUM_CONTACTOS && i < MAX_CONTACTOS; i++) {
    contactoEstable[i] = digitalRead(CONTACTOS[i].pin);
    contactoPrevio[i] = contactoEstable[i];
    tCambioContacto[i] = 0;
  }

  secuencia = esp_random();   // evita repetir numeros tras un reinicio
  armarIdentificadores();

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
  imprimirMac("[MAC] Esta placa (nodo C3): ");

  Serial.print("[PIR] Estabilizando el sensor durante ");
  Serial.print(PIR_ESTABILIZACION_MS / 1000);
  Serial.println(" s. Sus lecturas se ignoran hasta entonces.");
}

void loop() {
  unsigned long ahora = millis();

  // ---- Contactos magneticos con filtrado de rebote ----
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

  // ---- Sensor de movimiento ----
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
    // Respaldo por sondeo por si la interrupcion no llegara a dispararse
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

  // ---- Enlace con el receptor ----
  if (!enlazado) {
    if (ahora - tUltimaBusqueda > INTERVALO_BUSQUEDA_MS) {
      tUltimaBusqueda = ahora;
      enlazado = buscarCanal();
      fallosSeguidos = 0;
      if (enlazado) tUltimoLatido = 0;   // reporta el estado enseguida
    }
  }

  // ---- Estado periodico: registra los sensores y corrige eventos perdidos ----
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
