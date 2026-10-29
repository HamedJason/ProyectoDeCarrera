<script setup>
import { computed } from 'vue';
import {
  camara, deteccion, eventos, camaraVisible, nota, enviandoFoto, solicitarFoto
} from '../stores/camara.js';
import { ui } from '../stores/ui.js';
import { agruparEventos } from '../utils/eventosCamara.js';
import { formatearFecha } from '../utils/formato.js';

const resumen = computed(() => {
  if (!camara.value) return { est: 'off', etiqueta: 'Sin conexión', detalle: '' };
  const det = deteccion.value && deteccion.value.activa ? deteccion.value : null;
  const ultimo = agruparEventos(eventos.value)[0];
  let est = 'ok', etiqueta = 'En línea', detalle = '';
  if (!camara.value.en_linea) {
    est = 'off'; etiqueta = 'Sin conexión';
    detalle = 'No responde. Revisa que tenga corriente y Wi-Fi.';
  } else if (det && det.conectado && det.persona === true) {
    est = 'alerta'; etiqueta = 'Ve a una persona'; detalle = 'Ahora mismo en el encuadre.';
  } else if (det && det.conectado && det.movimiento === true) {
    est = 'alerta'; etiqueta = 'Ve movimiento'; detalle = 'Abre la vista en vivo para revisarlo.';
  } else if (det && !det.conectado) {
    detalle = 'Detección sin conexión; se reintenta sola.';
  } else if (det) {
    detalle = 'Vigilando, sin nada en el encuadre.';
  } else {
    detalle = 'Lista para ver en vivo o tomar una foto.';
  }
  if (ultimo && est === 'ok' && det && det.conectado) {
    detalle = 'Vigilando · última ' + (ultimo.detector === 'persona' ? 'persona' : 'movimiento') + ' ' + formatearFecha(ultimo.t);
  }
  return { est, etiqueta, detalle };
});

const sinLinea = computed(() => !(camara.value && camara.value.en_linea));
</script>

<template>
  <div v-if="camaraVisible" class="cam-mini" :data-est="resumen.est">
    <div class="cam-cab">
      <span class="cam-icono" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h8A2.5 2.5 0 0 1 16 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 15.5z" /><path d="m16 10.5 4.2-2.4a.6.6 0 0 1 .9.5v6.8a.6.6 0 0 1-.9.5L16 13.5" /></svg>
        <i class="cam-punto"></i>
      </span>
      <div class="cam-texto">
        <div class="cam-titulo">Cámara <span>· {{ resumen.etiqueta }}</span></div>
        <div class="cam-detalle">{{ resumen.detalle }}</div>
      </div>
    </div>
    <div class="cam-acciones">
      <button type="button" class="cam-btn primario" :disabled="sinLinea" @click="ui.vivo = true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></svg>Ver en vivo
      </button>
      <button type="button" class="cam-btn" :disabled="sinLinea || enviandoFoto" @click="solicitarFoto">
        <svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.2-1.8h6.2L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="13" r="3.2" /></svg>Tomar foto
      </button>
    </div>
    <div class="cam-nota" aria-live="polite">{{ nota }}</div>
  </div>
</template>
