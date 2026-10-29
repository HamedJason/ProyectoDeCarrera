/*
 * Apariencia: tema (claro, oscuro o el del sistema) y movimiento (normal o
 * reducido). Se guarda en este dispositivo y se aplica sobre <html> con
 * data-tema y data-movimiento, que es lo que leen los estilos.
 */
import { ref } from 'vue';

const COLORES_BARRA = { claro: '#E6EBE7', oscuro: '#262624' };

function leer(clave, valido, defecto) {
  try {
    const v = localStorage.getItem(clave);
    return valido.includes(v) ? v : defecto;
  } catch (e) { return defecto; }
}
function guardar(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch (e) { /* sin almacenamiento: dura solo esta sesion */ }
}

export const preferenciaTema = ref(leer('tema', ['auto', 'claro', 'oscuro'], 'auto'));
export const movimientoReducido = ref(leer('movimiento', ['normal', 'reducido'], 'normal') === 'reducido');

const sistemaOscuro = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function temaResuelto() {
  if (preferenciaTema.value === 'auto') return sistemaOscuro && sistemaOscuro.matches ? 'oscuro' : 'claro';
  return preferenciaTema.value;
}

export function aplicarApariencia() {
  const raiz = document.documentElement;
  const tema = temaResuelto();
  raiz.dataset.tema = tema;
  raiz.dataset.movimiento = movimientoReducido.value ? 'reducido' : 'normal';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', COLORES_BARRA[tema]);
}

export function elegirTema(valor) {
  preferenciaTema.value = valor;
  guardar('tema', valor);
  aplicarApariencia();
}

export function alternarMovimiento() {
  movimientoReducido.value = !movimientoReducido.value;
  guardar('movimiento', movimientoReducido.value ? 'reducido' : 'normal');
  aplicarApariencia();
}

// Con "automatico" el tema sigue al sistema aunque cambie con la app abierta
if (sistemaOscuro && sistemaOscuro.addEventListener) {
  sistemaOscuro.addEventListener('change', () => { if (preferenciaTema.value === 'auto') aplicarApariencia(); });
}
