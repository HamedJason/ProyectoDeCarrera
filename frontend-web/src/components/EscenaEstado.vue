<!-- Tarjeta principal: titular del estado, botones de armado y estado de la camara -->
<script setup>
import { computed } from 'vue';
import CamaraMini from './CamaraMini.vue';
import { estado, estadoCargado, ocupado, alternarArmado, apagarAlarma } from '../stores/casa.js';
import { vivienda } from '../stores/sesion.js';
import { formatearFecha } from '../utils/formato.js';

const alarma = computed(() => !!estado.value.alarma_activa);
const clase = computed(() => {
  if (!vivienda.value) return 'desarmado';
  return alarma.value ? 'alarma' : (estado.value.armado ? 'armado' : 'desarmado');
});

const titular = computed(() => {
  if (!vivienda.value) return 'Aún no tienes una vivienda';
  if (!estadoCargado.value) return 'Consultando la casa';
  if (alarma.value) return estado.value.alarma_motivo || 'Actividad detectada';
  return estado.value.armado ? 'La casa está armada' : 'La casa está desarmada';
});

const subtitular = computed(() => {
  if (!vivienda.value) return 'Crea una o únete con un código de invitación.';
  if (!estadoCargado.value) return '';
  if (alarma.value) return 'La alarma está sonando con la casa armada';
  const e = estado.value;
  return e.actualizado_en
    ? (e.armado ? 'Armada' : 'Desarmada') + ' desde ' + formatearFecha(e.actualizado_en).toLowerCase()
    : '';
});
</script>

<template>
  <section class="escena" :class="clase" aria-label="Estado de la casa">
    <div class="texto-escena">
      <h1 class="titular" aria-live="polite"><Transition name="titular" mode="out-in"><span :key="titular">{{ titular }}</span></Transition></h1>
      <p class="subtitular">{{ subtitular }}</p>
    </div>

    <div class="lado">
      <div class="controles">
        <button v-if="alarma" class="boton apagar-alarma" :disabled="ocupado" @click="apagarAlarma">Apagar alarma</button>
        <button
          v-if="vivienda"
          class="boton" :class="estado.armado ? 'desarmar' : 'armar'"
          :disabled="ocupado" @click="alternarArmado"
        >{{ estado.armado ? 'Desarmar la casa' : 'Armar la casa' }}</button>
      </div>
      <CamaraMini />
    </div>
  </section>
</template>
