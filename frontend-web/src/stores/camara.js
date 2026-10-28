// Estado y acciones de la camara: deteccion, eventos, galeria de fotos y solicitud de fotos

import { ref, computed } from 'vue';
import { pedir, enviarJson, ErrorSesion, mensajeDeError } from '../api/cliente.js';
import { vivienda } from './sesion.js';

export const camara = ref(null);
export const deteccion = ref(null);      // estado de la deteccion ONVIF (null si el servidor no la usa)
export const eventos = ref([]);          // eventos que guarda el servidor (persona y movimiento detectados por la propia camara)
export const fotos = ref([]);
export const limiteEventos = ref(6);
export const limiteFotos = ref(12);
export const nota = ref('');             // mensaje bajo los botones de la tarjeta de la camara
export const enviandoFoto = ref(false);

// Se muestra la camara si esta registrada o si ya hay fotos guardadas
export const camaraVisible = computed(() => !!camara.value && (camara.value.registrada || fotos.value.length > 0));

export function reiniciarCamara() {
  camara.value = null; deteccion.value = null; eventos.value = []; fotos.value = [];
  limiteEventos.value = 6; limiteFotos.value = 12; nota.value = '';
}

export async function refrescarCamara() {
  if (!vivienda.value) return;
  const casa = vivienda.value;
  try {
    const q = encodeURIComponent(casa);
    // La deteccion es opcional: si el servidor no la tiene o falla, la pagina sigue igual
    const opcional = (p) => p.catch((e) => { if (e instanceof ErrorSesion) throw e; return null; });
    const [c, f, ev, det] = await Promise.all([
      pedir('/camara/estado?vivienda_id=' + q),
      pedir('/fotos?vivienda_id=' + q + '&limite=' + limiteFotos.value),
      opcional(pedir('/camara/eventos?vivienda_id=' + q + '&limite=100')),
      opcional(pedir('/camara/deteccion?vivienda_id=' + q))
    ]);
    if (casa !== vivienda.value) return;
    camara.value = c;
    fotos.value = f && f.fotos ? f.fotos : [];
    eventos.value = ev && ev.eventos ? ev.eventos : [];
    deteccion.value = det && det.ok ? det : null;
  } catch (e) { /* la camara es opcional: un fallo no debe molestar */ }
}

export function verMasEventos() { limiteEventos.value += 10; }
export function verMasFotos() { limiteFotos.value += 24; refrescarCamara(); }

export async function solicitarFoto() {
  enviandoFoto.value = true;
  nota.value = '';
  try {
    const r = await enviarJson('/camara/solicitar', 'POST', { vivienda_id: vivienda.value });
    if (!r.ok) { nota.value = r.datos.mensaje || 'No se pudo pedir la foto.'; return; }
    nota.value = 'Foto en camino…';
    let n = 0;
    const t = setInterval(() => {
      refrescarCamara();
      if (++n >= 6) { clearInterval(t); nota.value = ''; }
    }, 1500);
  } catch (e) {
    if (!(e instanceof ErrorSesion)) nota.value = mensajeDeError(e);
  } finally {
    enviandoFoto.value = false;
  }
}
