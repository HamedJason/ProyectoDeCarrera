/*
 * Avisos en el dispositivo: vibracion, sonido, parpadeo del titulo y
 * notificaciones push.
 *
 * Las notificaciones del sistema exigen una conexion segura (HTTPS o
 * localhost). Con el servidor en HTTP no estan disponibles, y para eso existen
 * las notificaciones push del servidor, que llegan aunque la app este cerrada.
 * En iPhone solo funciona el push cuando la pagina se agrego a la pantalla de
 * inicio y se abre desde ese icono.
 */
import { ref } from 'vue';
import { pedir, pedirJson, mensajeDeError } from '../api/cliente.js';
import { base64AUint8 } from '../utils/formato.js';
import { sesion, nombreCasa } from './sesion.js';
import { mostrarAviso } from './conexion.js';

const TITULO_ORIGINAL = document.title;
const NOTA_BASE_SIN_CONFIG = 'Notificaciones push, sonido y vibración cuando suene la alarma';

export const avisosActivos = ref(leerPreferencia());
export const notaAvisos = ref(NOTA_BASE_SIN_CONFIG);
export const conPush = ref(false);              // muestra la fila "Probar notificacion"
export const textoPrueba = ref('Enviar');
export const modoPruebas = ref(false);          // lo decide el servidor

let notaAvisosBase = '';
let contextoAudio = null;
let parpadeoTitulo = null;
let registroSw = null;

const esIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const esInstalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function leerPreferencia() {
  try { return localStorage.getItem('avisos') === '1'; } catch (e) { return false; }
}
function guardarPreferencia(v) {
  try { localStorage.setItem('avisos', v ? '1' : '0'); } catch (e) { /* sin almacenamiento */ }
}

function pushDisponible() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registrarServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    registroSw = registroSw || await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    return registroSw;
  } catch (e) { return null; }
}

// Explica por que no hay push, o devuelve '' si todo esta disponible
export function motivoSinPush() {
  if (!window.isSecureContext) return 'Las notificaciones push requieren abrir la app por HTTPS.';
  if (esIos && !esInstalada) return 'En iPhone, agrega la app a la pantalla de inicio (Compartir → Agregar a inicio) y ábrela desde ahí para activar las notificaciones push.';
  if (!pushDisponible()) return 'Este navegador no admite notificaciones push.';
  if ('Notification' in window && Notification.permission === 'denied') return 'Las notificaciones están bloqueadas. Actívalas en Ajustes → Notificaciones para esta app.';
  return '';
}

export async function suscribirPush() {
  const reg = await registrarServiceWorker();
  if (!reg) throw new Error('No se pudo iniciar el servicio de notificaciones.');
  const c = await pedir('/push/clave');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64AUint8(c.clave) });
  }
  // El telefono recibe los avisos de todas las viviendas de la cuenta
  const casas = sesion.value ? sesion.value.viviendas : [];
  await Promise.all(casas.map((c) => pedirJson('/push/suscribir', { vivienda_id: c.id, suscripcion: sub.toJSON() })));
}

export async function cancelarPush() {
  try {
    const reg = await registrarServiceWorker();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return;
    await pedirJson('/push/cancelar', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  } catch (e) { /* se ignora */ }
}

export async function probarPush() {
  textoPrueba.value = 'Enviando';
  try {
    const reg = await registrarServiceWorker();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) throw new Error('Este dispositivo no está suscrito.');
    const r = await pedirJson('/push/prueba', { endpoint: sub.endpoint });
    if (!r || !r.ok) throw new Error((r && r.mensaje) || 'Este dispositivo no está suscrito. Apaga y vuelve a activar los avisos.');
    textoPrueba.value = 'Enviada';
  } catch (e) {
    mostrarAviso(mensajeDeError(e));
    textoPrueba.value = 'Enviar';
    return;
  }
  setTimeout(() => { textoPrueba.value = 'Enviar'; }, 2500);
}

function pintarPush(nota) {
  conPush.value = avisosActivos.value && 'Notification' in window &&
    Notification.permission === 'granted' && !motivoSinPush();
  if (nota !== undefined) notaAvisos.value = nota;
}

export async function alternarAvisos() {
  avisosActivos.value = !avisosActivos.value;
  guardarPreferencia(avisosActivos.value);
  if (!avisosActivos.value) {
    await cancelarPush();
    pintarPush(notaAvisosBase);
    return;
  }

  // El permiso debe pedirse directamente desde el toque, antes de cualquier
  // otra espera, o iOS lo rechaza por no venir de un gesto del usuario
  const motivo = motivoSinPush();
  let permiso = 'Notification' in window ? Notification.permission : 'denied';
  if (!motivo && permiso === 'default') {
    try { permiso = await Notification.requestPermission(); } catch (e) { /* se ignora */ }
  }

  // El audio solo se puede iniciar tras un gesto del usuario, como este toque
  try {
    contextoAudio = contextoAudio || new (window.AudioContext || window.webkitAudioContext)();
    if (contextoAudio.state === 'suspended') await contextoAudio.resume();
    sonar(0.15);
  } catch (e) { /* el navegador no soporta audio */ }
  if (navigator.vibrate) navigator.vibrate(120);

  if (motivo) { pintarPush(motivo); return; }
  if (permiso !== 'granted') { pintarPush('Permiso de notificaciones no concedido. Puedes activarlo en Ajustes → Notificaciones.'); return; }
  try {
    await suscribirPush();
    pintarPush(notaAvisosBase);
  } catch (e) {
    pintarPush('No se pudo activar el push: ' + (e.message || 'error desconocido'));
  }
}

// Al abrir la app, renueva la suscripcion por si el navegador cambio su direccion
export async function sincronizarPush() {
  await registrarServiceWorker();
  if (!avisosActivos.value) { pintarPush(); return; }
  const motivo = motivoSinPush();
  if (motivo) { pintarPush(motivo); return; }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { await suscribirPush(); } catch (e) { /* se reintenta al abrir de nuevo */ }
  }
  pintarPush();
}

// Activa el aviso push en la vivienda nueva si este dispositivo ya los tenia activos
export function reanudarPush() {
  if (avisosActivos.value && !motivoSinPush() && Notification.permission === 'granted') suscribirPush().catch(() => {});
}

export async function cargarConfiguracion() {
  try {
    const c = await pedir('/configuracion');
    if (!c) return;
    modoPruebas.value = !!c.modo_pruebas;
    notaAvisosBase = c.web_push
      ? 'Notificaciones push, sonido y vibración cuando suene la alarma'
      : 'Sonido y vibración con la app abierta. Las notificaciones push no están disponibles en el servidor.';
    pintarPush(notaAvisosBase);
  } catch (e) { /* se reintenta en el siguiente arranque */ }
}

function sonar(duracion) {
  if (!contextoAudio) return;
  const osc = contextoAudio.createOscillator();
  const vol = contextoAudio.createGain();
  osc.type = 'square';
  osc.frequency.value = 880;
  vol.gain.value = 0.15;
  osc.connect(vol); vol.connect(contextoAudio.destination);
  osc.start();
  osc.stop(contextoAudio.currentTime + duracion);
}

export function alertar(motivo) {
  // El titulo parpadea aunque los avisos esten apagados, porque es discreto
  // y ayuda a notar la pestana
  if (!parpadeoTitulo) {
    let alterno = false;
    parpadeoTitulo = setInterval(() => {
      document.title = alterno ? TITULO_ORIGINAL : '🚨 ALARMA ACTIVA';
      alterno = !alterno;
    }, 800);
  }
  if (!avisosActivos.value) return;

  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  try { sonar(0.25); setTimeout(() => sonar(0.25), 400); setTimeout(() => sonar(0.25), 800); } catch (e) { /* sin audio */ }

  // Con push activo el propio sistema ya muestra el aviso; esta es la alternativa sin push
  if (!pushDisponible() && window.isSecureContext && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('ALARMA ACTIVA', { body: (motivo || 'Se detectó actividad') + ' en ' + nombreCasa.value, tag: 'alarma' }); } catch (e) { /* se ignora */ }
  }
}

export function restaurarTitulo() {
  if (parpadeoTitulo) { clearInterval(parpadeoTitulo); parpadeoTitulo = null; }
  document.title = TITULO_ORIGINAL;
}
