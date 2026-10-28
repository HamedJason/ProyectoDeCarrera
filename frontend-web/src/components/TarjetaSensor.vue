<!--
  Tarjeta de un sensor (puerta, ventana o movimiento). Solo cambian clases y
  textos, asi las animaciones no se reinician en cada consulta.
-->
<script setup>
import { computed } from 'vue';
import IlustracionSensor from './IlustracionSensor.vue';
import { estado, nodos, MOVIMIENTO_RECIENTE_S } from '../stores/casa.js';
import { abrirSensor } from '../stores/ui.js';
import { hace } from '../utils/formato.js';

const props = defineProps({ sensor: { type: Object, required: true } });

const vista = computed(() => {
  const s = props.sensor;
  const alarmaAqui = !!estado.value.alarma_activa && estado.value.alarma_sensor === s.sensor_id;
  const sinDatos = !s.ultima_lectura;
  let lectura, cuando, clases;

  if (s.tipo === 'movimiento') {
    const det = s.ultima_deteccion;
    const reciente = !!det && (Date.now() - new Date(det)) / 1000 < MOVIMIENTO_RECIENTE_S;
    lectura = reciente ? 'Movimiento ahora' : (det ? 'Sin movimiento' : (sinDatos ? 'Sin datos' : 'Sin detecciones'));
    cuando = reciente ? '' : (det ? 'última vez ' + hace(det) : '');
    clases = ['tarjeta', 'movimiento'];
    if (reciente) clases.push('actividad');
  } else {
    const abierta = Number(s.ultimo_valor) === 1 && !sinDatos;
    lectura = sinDatos ? 'Sin datos' : (abierta ? 'Abierta' : 'Cerrada');
    cuando = sinDatos ? 'Aún no reporta' : hace(s.ultima_lectura);
    clases = ['tarjeta', s.tipo];
    if (abierta) clases.push('abierta');
  }
  const nodo = nodos.value.find((n) => n.nodo_id === s.nodo_id);
  if (nodo && !nodo.en_linea) {
    lectura = 'Sin señal';
    cuando = 'el nodo no responde';
    clases = clases.filter((c) => c !== 'abierta' && c !== 'actividad');
    clases.push('sin-datos');
  }
  if (s.confirmado === false) clases.push('nuevo');
  if (sinDatos) clases.push('sin-datos');
  if (alarmaAqui) clases.push('disparado');
  if (estado.value.armado) clases.push('armado');

  return {
    clases: [...new Set(clases)],
    lectura,
    cuando,
    aria: s.nombre + (s.confirmado === false ? ' (nuevo)' : '') + ': ' + lectura + '. Toca para editar.'
  };
});
</script>

<template>
  <button type="button" :class="vista.clases" :aria-label="vista.aria" @click="abrirSensor(sensor)">
    <div class="ilu"><IlustracionSensor :tipo="sensor.tipo" /></div>
    <div class="nombre">{{ sensor.nombre }}</div>
    <div class="lectura">{{ vista.lectura }}</div>
    <div class="cuando">{{ vista.cuando }}</div>
    <svg class="lapiz" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
  </button>
</template>
