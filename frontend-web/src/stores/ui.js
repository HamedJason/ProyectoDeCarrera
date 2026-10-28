// Estado de las hojas (dialogos) y de lo que se esta editando en ellas

import { reactive } from 'vue';
import { vivienda } from './sesion.js';

export const ui = reactive({
  sensor: false,          // dialogo de alta/edicion de sensor
  sensorEditado: null,    // sensor que se edita; null cuando se agrega uno nuevo
  casas: false,           // viviendas y cuenta
  gestion: false,         // administracion de la vivienda actual
  tokenPendiente: null,   // token recien generado, que se muestra una sola vez
  foto: false,
  fotoAbierta: null,
  vivo: false
});

export function abrirSensor(s) { ui.sensorEditado = s || null; ui.sensor = true; }
export function abrirCasas() { ui.casas = true; }
export function abrirGestion() { if (vivienda.value) ui.gestion = true; }
export function cerrarTodo() {
  ui.sensor = ui.casas = ui.gestion = ui.foto = ui.vivo = false;
}
