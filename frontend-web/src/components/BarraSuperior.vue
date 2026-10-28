<!-- Barra superior: selector de vivienda y estado de la conexion -->
<script setup>
import { computed } from 'vue';
import { vivienda, nombreCasa } from '../stores/sesion.js';
import { conexion } from '../stores/conexion.js';
import { abrirCasas } from '../stores/ui.js';

const nombre = computed(() => (vivienda.value ? nombreCasa.value : 'Sin vivienda'));
const pie = computed(() => (vivienda.value ? conexion.pie : ''));
</script>

<template>
  <header class="barra">
    <button class="vivienda-btn" aria-haspopup="dialog" @click="abrirCasas">
      <span>{{ nombre }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    <div class="conexion" role="status">
      <span class="punto-vivo" :class="{ muerto: conexion.muerto }"></span><span>{{ pie }}</span>
    </div>
  </header>
</template>
