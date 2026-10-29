// Nodo periferico sobre ESP32-C3. No se conecta a Internet: lee sus sensores y manda cada evento por ESP-NOW
// al concentrador (nodo_sensor.ino), que decide si suena la alarma y avisa al backend.
//   [MC-38 + AM312] -> ESP32-C3 --ESP-NOW--> concentrador --Wi-Fi--> backend
//
// Emparejamiento automatico: no hay MAC ni canal en el codigo. La primera vez el C3 busca al concentrador en los
// canales 1 a 13 y le pide enlazarse; este responde si tiene abierto el comando "emparejar". El C3 guarda la MAC
// del concentrador en flash y, tras un reinicio, solo vuelve a buscar el canal (el del router).
// Si el concentrador esta apagado, los eventos esperan en una cola pequena.
//
// Comandos por el Monitor Serie (115200, "Nueva linea"): ver, olvidar, reiniciar, ayuda, llave.
//
// Ahorro de bateria (USAR_SUENO): el nodo pasa casi todo el tiempo en suspension ligera con la radio apagada
// (~0.2 mA en vez de ~60 mA). Lo despiertan un cambio del contacto magnetico (se envia al instante), el
// movimiento del PIR (solo con la casa armada) y un temporizador (INTERVALO_LATIDO_MS) para el latido y para
// preguntar si la casa sigue armada. El concentrador contesta cada transmision con el estado de armado
// (TIPO_ARMADO); mientras el nodo no lo sabe, asume "armado". Con la casa desarmada el PIR no despierta al
// nodo y el cambio llega en el siguiente latido. Para depurar sin dormir, USAR_SUENO = false.
// El pull-up interno (~45 kohm) gasta ~70 uA por contacto cerrado; con 1 Mohm externo a 3V3 y
// PULLUP_EXTERNO = true baja a ~3 uA.
//
// Conexiones (los pines se cambian abajo):
//   MC-38: un cable al GPIO 4 (y otro al 3) y el otro a GND, con pull-up interno
//   AM312: VCC a 3V3 (o 5V), GND a GND, VOUT al GPIO 5
// Evitar en el C3 los pines 2, 8 y 9 (arranque) y 18 y 19 (USB).

#include <WiFi.h>
#include <Preferences.h>
#include <esp_now.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <esp_wifi.h>
#include <esp_idf_version.h>
#include <esp_sleep.h>
#include <driver/gpio.h>
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include <esp_mac.h>
#else
#include <esp_system.h>
#endif

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

// Cada C3 lleva un solo sensor. Deja en true solo el que tenga; el nodo magnetico
// no necesita saber si la casa esta armada y por eso hace un latido mas espaciado.
// (Para pruebas se pueden activar los dos.)
const bool USA_PIR = true;
const bool USA_CONTACTOS = true;
const int NUM_ACTIVOS = USA_CONTACTOS ? NUM_CONTACTOS : 0;

const int PIN_PIR = 5;    // salida del AM312, activa en alto
const int PIN_LED = -1;   // LED de enlace opcional (-1 si no hay)

const bool USAR_SUENO = true;

// Modo de medicion (para probar con el USB conectado): no duerme y, en cada sesion de radio, imprime cuanto duro
// encenderla, transmitir y apagarla para estimar el consumo promedio. Las corrientes son tipicas del ESP32-C3;
// sustituyelas por las que midas.
const bool MODO_MEDICION = false;
const float I_ACTIVO_MA = 70.0;    // radio encendida y transmitiendo
const float I_DORMIDO_MA = 0.17;   // suspension ligera
const bool PULLUP_EXTERNO = false;   // true si cada contacto lleva 1 Mohm a 3V3

// Cifrado y firma de ESP-NOW; debe coincidir con el concentrador. La llave NO
// esta en el codigo: se carga por consola con el comando llave y vive en la
// flash. Si no hay llave guardada, el nodo funciona sin cifrar y lo avisa.
const bool USAR_CIFRADO = true;

const unsigned long DEBOUNCE_MS = 50;
const unsigned long BLOQUEO_PIR_MS = 8000;
const unsigned long PIR_ESTABILIZACION_MS = 45000;   // el AM312 tarda 30-60 s en estabilizarse
// Latido: demuestra que el nodo sigue vivo y corrige eventos perdidos. El nodo PIR
// ademas pregunta con el si la casa esta armada, por eso va mas seguido. El
// backend da un nodo por perdido a los 120 s, asi que no pasar de 60 s.
const unsigned long INTERVALO_LATIDO_MS = USA_PIR ? 20000UL : 60000UL;
// Potencia de transmision en cuartos de dBm (44 = 11 dBm). 0 = la del core
// (20 dBm). Bajarla ahorra bateria si el concentrador esta cerca; probar el alcance.
const int POTENCIA_TX_CUARTOS_DBM = 0;
const unsigned long VENTANA_CONSOLA_MS = 15000;      // tras arrancar no duerme, para usar el Monitor Serie
const unsigned long ESPERA_ARMADO_MS = 30;           // escucha la respuesta del concentrador
const unsigned long BUSQUEDA_MAX_MS = 60000;         // espera maxima entre busquedas si no hay concentrador
const unsigned long ESPERA_CONFIRMACION_MS = 80;
const unsigned long ESPERA_RESPUESTA_MS = 100;       // por canal, al pedir emparejarse
const int  REINTENTOS_ENVIO = 3;
const int  FALLOS_PARA_REBUSCAR = 3;
const unsigned long INTERVALO_BUSQUEDA_MS = 2000;

// Protocolo: igual que en nodo_sensor.ino

const uint8_t TIPO_EVENTO    = 1;
const uint8_t TIPO_ESTADO    = 2;
const uint8_t TIPO_HOLA      = 3;
const uint8_t TIPO_EMPAREJAR = 4;
const uint8_t TIPO_RESPUESTA = 5;
const uint8_t TIPO_ARMADO    = 6;   // el concentrador dice si la casa esta armada (valor 1/0)

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
  uint8_t  tag[8];        // firma HMAC-SHA256 recortada
};

const uint8_t MAC_BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

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
uint8_t hubMac[6];          // MAC del concentrador, guardada al emparejar
bool hubGuardado = false;

bool enlazado = false;      // hay canal comun con el concentrador
int  fallosSeguidos = 0;
unsigned long tUltimaBusqueda = 0;
unsigned long tUltimoLatido = 0;
bool registroPirEnviado = false;
int  rondasEmparejar = 0;

bool armado = true;                 // hasta que el concentrador diga lo contrario, se vigila
volatile bool armadoRecibido = false;
volatile int8_t armadoValor = 1;
bool radioActiva = false;
int  canalHub = 0;                  // canal en el que se encontro al concentrador
unsigned long intervaloBusqueda = INTERVALO_BUSQUEDA_MS;
bool hubo_envio = false;            // hubo envios en este ciclo y falta oir la respuesta

unsigned long tRadioInicio = 0;
unsigned long msRadioListo = 0;
unsigned long sesionesMedidas = 0;
unsigned long acumActivoMs = 0;
unsigned long acumDormidoMs = 0;
int paquetesSesion = 0;

uint32_t secuencia = 0;
volatile uint32_t ultimaSecEnviada = 0;   // las respuestas del concentrador deben repetirla

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
  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
    if (CONTACTOS[i].idAntiguo[0]) snprintf(contactoId[i], sizeof(contactoId[i]), "%s", CONTACTOS[i].idAntiguo);
    else snprintf(contactoId[i], sizeof(contactoId[i]), "%s-gpio%d", NODO_ID, CONTACTOS[i].pin);
  }
}

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
  if (largo != (int)sizeof(PaqueteSensor)) return;
  const PaqueteSensor* p = (const PaqueteSensor*)datos;
  if (p->magia[0] != 'S' || p->magia[1] != 'R' || p->version != 1) return;
  if (!paqueteAutentico(p)) return;   // firma invalida: se ignora

  // Estado de armado: solo del concentrador al que se esta enlazado, y solo
  // como respuesta a lo ultimo que se envio (evita reenvios de respuestas viejas)
  if (p->tipo == TIPO_ARMADO) {
    if (hubGuardado && memcmp(mac, hubMac, 6) == 0 && strncmp(p->variable, macPropia, 12) == 0 &&
        p->secuencia == ultimaSecEnviada) {
      armadoValor = p->valor;
      armadoRecibido = true;
    }
    return;
  }

  if (hubGuardado) return;
  if (p->tipo != TIPO_RESPUESTA) return;
  if (strncmp(p->variable, macPropia, 12) != 0) return;
  if (p->secuencia != ultimaSecEnviada) return;   // debe contestar a nuestra peticion
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

bool registrarHub() {
  if (esp_now_is_peer_exist(hubMac)) esp_now_del_peer(hubMac);
  esp_now_peer_info_t par = {};
  memcpy(par.peer_addr, hubMac, 6);
  par.channel = 0;   // 0 = el canal actual, que cambia al buscar
  par.ifidx = WIFI_IF_STA;
  par.encrypt = cifradoActivo;
  if (cifradoActivo) {
    uint8_t propia[6];
    esp_read_mac(propia, ESP_MAC_WIFI_STA);
    lmkDeNodo(propia, par.lmk);   // la misma LMK que deriva el concentrador para este nodo
  }
  return esp_now_add_peer(&par) == ESP_OK;
}

bool iniciarEspNow() {
  WiFi.persistent(false);   // no escribir la configuracion de Wi-Fi en flash en cada despertar
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  if (POTENCIA_TX_CUARTOS_DBM > 0) esp_wifi_set_max_tx_power(POTENCIA_TX_CUARTOS_DBM);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] No se pudo iniciar.");
    return false;
  }
  if (cifradoActivo) esp_now_set_pmk(pmkDerivada);
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
  PaqueteSensor f = p;           // copia firmada: el original queda en la cola
  firmarPaquete(&f);
  ultimaSecEnviada = f.secuencia;
  if (esp_now_send(hubMac, (const uint8_t*)&f, sizeof(f)) != ESP_OK) return false;
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
        canalHub = c;
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
    firmarPaquete(&req);
    ultimaSecEnviada = req.secuencia;
    esp_now_send(MAC_BROADCAST, (const uint8_t*)&req, sizeof(req));
    unsigned long t0 = millis();
    while (!respuestaRecibida && millis() - t0 < ESPERA_RESPUESTA_MS) delay(1);
    if (respuestaRecibida) { canalHub = c; return true; }
  }
  return false;
}

bool radioEncender() {
  if (radioActiva) return true;
  tRadioInicio = millis();
  paquetesSesion = 0;
  if (!iniciarEspNow()) return false;
  if (canalHub > 0) esp_wifi_set_channel(canalHub, WIFI_SECOND_CHAN_NONE);
  radioActiva = true;
  msRadioListo = millis() - tRadioInicio;
  return true;
}

void radioApagar() {
  if (!radioActiva) return;
  esp_now_deinit();
  WiFi.mode(WIFI_OFF);
  radioActiva = false;

  if (MODO_MEDICION) {
    unsigned long dur = millis() - tRadioInicio;
    sesionesMedidas++;
    acumActivoMs += dur;
    unsigned long total = acumActivoMs + acumDormidoMs;
    float prom = total ? (acumActivoMs * I_ACTIVO_MA + acumDormidoMs * I_DORMIDO_MA) / total : 0;
    Serial.printf("[Medicion] sesion %lu: radio lista en %lu ms, paquetes %d, sesion total %lu ms\n",
                  sesionesMedidas, msRadioListo, paquetesSesion, dur);
    Serial.printf("[Medicion] despierto %.2f %% del tiempo, consumo promedio estimado %.3f mA\n",
                  total ? 100.0 * acumActivoMs / total : 0.0, prom);
  }
}

void aplicarArmado() {
  if (!armadoRecibido) return;
  armadoRecibido = false;
  bool nuevo = (armadoValor != 0);
  if (nuevo != armado) {
    armado = nuevo;
    Serial.print("[Armado] La casa esta ");
    Serial.println(armado ? "ARMADA: se vigila el movimiento." : "DESARMADA: se ignora el movimiento.");
  }
}

// Tras transmitir, el concentrador contesta en pocos milisegundos
void esperarArmado() {
  if (!hubo_envio) return;
  hubo_envio = false;
  if (!USA_PIR) return;   // solo el PIR necesita saber si la casa esta armada
  unsigned long t0 = millis();
  while (!armadoRecibido && millis() - t0 < ESPERA_ARMADO_MS) delay(1);
  aplicarArmado();
}

// Suspension ligera con la radio ya apagada. Despierta por:
//  - un cambio en cualquier contacto (se espera el nivel contrario al actual,
//    asi que sea cual sea el cambio, abrir o cerrar, el nodo despierta);
//  - el PIR en alto, solo si vigilarPir;
//  - el temporizador.
void dormir(unsigned long ms, bool vigilarPir) {
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
    gpio_wakeup_enable((gpio_num_t)CONTACTOS[i].pin,
                       contactoEstable[i] == HIGH ? GPIO_INTR_LOW_LEVEL : GPIO_INTR_HIGH_LEVEL);
  }
  if (vigilarPir) gpio_wakeup_enable((gpio_num_t)PIN_PIR, GPIO_INTR_HIGH_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  esp_sleep_enable_timer_wakeup(ms * 1000ULL);
  if (Serial) Serial.flush();   // sin PC conectada, el USB no tiene a quien enviar
  esp_light_sleep_start();
  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) gpio_wakeup_disable((gpio_num_t)CONTACTOS[i].pin);
  gpio_wakeup_disable((gpio_num_t)PIN_PIR);
}

void guardarHub() {
  memcpy(hubMac, macRespuesta, 6);
  prefs.putBytes("hub", hubMac, 6);
  hubGuardado = true;
  registrarHub();
  Serial.print("[Emparejar] Enlazado con el concentrador ");
  Serial.println(macATexto(hubMac));
}

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
    hubo_envio = true;
    paquetesSesion++;
    // Cualquier paquete demuestra que el nodo esta vivo: se pospone el latido
    tUltimoLatido = millis() ? millis() : 1;
    Serial.print("[Envio] ");
    Serial.print(cola[0].tipo == TIPO_EVENTO ? "evento " : "estado ");
    Serial.print(cola[0].sensorId);
    Serial.print(" valor=");
    Serial.println(cola[0].valor);
    for (int i = 1; i < colaTam; i++) cola[i - 1] = cola[i];
    colaTam--;
  }
}

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
  Serial.print("Cifrado:      "); Serial.println(cifradoActivo ? "activo (llave guardada)" : "INACTIVO (sin llave)");
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
  } else if (linea.startsWith("llave")) {
    String a = linea.substring(5);
    a.trim();
    if (a == "borrar") {
      prefs.remove("llave");
      Serial.println("Llave borrada. Reiniciando (quedara sin cifrar).");
      delay(300);
      ESP.restart();
    } else if (guardarLlaveHex(a)) {
      Serial.println("Llave guardada. Reiniciando.");
      delay(300);
      ESP.restart();
    } else {
      Serial.println("Uso: llave 32_digitos_hex (la que muestra el concentrador) | llave borrar");
    }
  } else if (linea == "reiniciar") {
    ESP.restart();
  } else if (linea == "ayuda" || linea == "help" || linea == "?") {
    Serial.println("Comandos: ver, olvidar (volver a emparejar), llave, reiniciar");
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

void setup() {
  // 80 MHz basta para ESP-NOW y gasta menos que los 160 MHz por defecto
  if (USAR_SUENO) setCpuFrequencyMhz(80);
  Serial.begin(115200);
  delay(300);

  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
    pinMode(CONTACTOS[i].pin, PULLUP_EXTERNO ? INPUT : INPUT_PULLUP);
  }
  // Entrada simple para el AM312: su salida es debil y un pull-down interno
  // la dejaria en un nivel intermedio
  pinMode(PIN_PIR, USA_PIR ? INPUT : INPUT_PULLDOWN);   // sin PIR, evita una entrada flotante
  if (PIN_LED >= 0) pinMode(PIN_LED, OUTPUT);

  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
    contactoEstable[i] = digitalRead(CONTACTOS[i].pin);
    contactoPrevio[i] = contactoEstable[i];
    tCambioContacto[i] = 0;
  }

  armarIdentificadores();

  prefs.begin("nodo", false);
  if (prefs.getBytesLength("hub") == 6) {
    prefs.getBytes("hub", hubMac, 6);
    hubGuardado = true;
  }

  // La secuencia nunca retrocede entre reinicios: sus 12 bits altos son un contador de arranques guardado en flash,
  // asi el concentrador descarta secuencias menores (anti-replay) sin rechazar al nodo.
  uint32_t arranques = prefs.getUInt("arranques", 0) + 1;
  prefs.putUInt("arranques", arranques);
  secuencia = (arranques & 0xFFF) << 20;

  cargarLlave();

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" Nodo periferico ESP32-C3");
  Serial.print(" Nodo: "); Serial.println(NODO_ID);
  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
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
  radioActiva = true;
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
  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
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

  if (!USA_PIR) {
    // este nodo no lleva PIR
  } else if (!pirListo) {
    if (ahora >= PIR_ESTABILIZACION_MS) {
      pirListo = true;
      pirPulso = false;
      pirPrevio = digitalRead(PIN_PIR);
      // Con suspension no se usa interrupcion: el despertar por nivel hace su trabajo
      if (!USAR_SUENO) attachInterrupt(digitalPinToInterrupt(PIN_PIR), alDetectarPir, RISING);
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
      if (!armado) {
        Serial.println("   Ignorado: la casa esta desarmada.");
      } else if (tUltimoPir == 0 || ahora - tUltimoPir > BLOQUEO_PIR_MS) {
        tUltimoPir = ahora;
        PaqueteSensor p;
        llenarPaquete(p, TIPO_EVENTO, ID_PIR, "movimiento", ZONA, 1);
        encolar(p);
      } else {
        Serial.println("   Ignorado por el bloqueo entre eventos de movimiento.");
      }
    }
  }

  // Con suspension, la radio solo se enciende cuando hay algo que transmitir
  bool tocaLatido = hubGuardado && enlazado && (tUltimoLatido == 0 || ahora - tUltimoLatido >= INTERVALO_LATIDO_MS);
  bool tocaBuscar = !enlazado && ahora - tUltimaBusqueda >= (hubGuardado ? intervaloBusqueda : INTERVALO_BUSQUEDA_MS);
  if (USAR_SUENO && hubGuardado && !radioActiva && (colaTam > 0 || tocaLatido || tocaBuscar)) {
    if (!radioEncender()) delay(1000);
  }
  aplicarArmado();

  if (radioActiva && tocaBuscar) {
    tUltimaBusqueda = ahora;
    if (!hubGuardado) {
      if (buscarEmparejamiento()) {
        guardarHub();
        enlazado = true;
      }
    } else {
      enlazado = buscarCanal();
      // Sin concentrador, cada intento espera mas para no gastar la bateria
      if (enlazado) intervaloBusqueda = INTERVALO_BUSQUEDA_MS;
      else intervaloBusqueda = min(intervaloBusqueda * 2, BUSQUEDA_MAX_MS);
    }
    fallosSeguidos = 0;
    if (enlazado) tUltimoLatido = 0;   // reporta el estado enseguida
  }

  // Estado periodico: registra los sensores y corrige eventos perdidos
  if (radioActiva && enlazado && (tUltimoLatido == 0 || ahora - tUltimoLatido >= INTERVALO_LATIDO_MS)) {
    tUltimoLatido = ahora ? ahora : 1;
    PaqueteSensor p;
    for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
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

  if (radioActiva) vaciarCola();
  esperarArmado();

  if (!USAR_SUENO || !hubGuardado || ahora < VENTANA_CONSOLA_MS) {
    indicarLed(enlazado);
    delay(5);
    return;
  }

  // No dormir mientras haya algo por resolver
  bool pendiente = colaTam > 0 || Serial.available();
  for (int i = 0; i < NUM_ACTIVOS && i < MAX_CONTACTOS; i++) {
    if (digitalRead(CONTACTOS[i].pin) != contactoEstable[i]) pendiente = true;   // rebote en curso
  }
  if (pendiente) { delay(5); return; }

  // Cuanto dormir como maximo: hasta el siguiente latido o intento de busqueda
  ahora = millis();
  unsigned long limite;
  if (enlazado) {
    unsigned long t = ahora - tUltimoLatido;
    limite = t >= INTERVALO_LATIDO_MS ? 100 : INTERVALO_LATIDO_MS - t;
  } else {
    unsigned long t = ahora - tUltimaBusqueda;
    limite = t >= intervaloBusqueda ? 100 : intervaloBusqueda - t;
  }
  if (USA_PIR && !pirListo) {
    unsigned long resto = ahora >= PIR_ESTABILIZACION_MS ? 100 : PIR_ESTABILIZACION_MS - ahora;
    if (resto < limite) limite = resto;
  }

  // El PIR solo despierta al nodo si la casa esta armada y el sensor esta en
  // reposo (en alto no se puede esperar un nivel alto; se revisa cada 300 ms).
  bool vigilarPir = false;
  if (USA_PIR && pirListo && armado) {
    bool libre = digitalRead(PIN_PIR) == LOW && (tUltimoPir == 0 || ahora - tUltimoPir > BLOQUEO_PIR_MS);
    if (libre) vigilarPir = true;
    else if (limite > 300) limite = 300;
  }

  radioApagar();
  indicarLed(false);
  if (MODO_MEDICION) {
    // Sin dormir, para no perder el USB; ese tiempo se cuenta como "dormido"
    unsigned long espera = limite > 2000 ? 2000 : limite;
    delay(espera);
    acumDormidoMs += espera;
  } else {
    dormir(limite, vigilarPir);
  }
}
