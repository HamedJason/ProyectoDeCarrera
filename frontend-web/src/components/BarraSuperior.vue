<!-- Barra superior: selector de vivienda, estado de la conexion y acceso al panel lateral -->
<script setup>
import { computed } from 'vue';
import { vivienda, nombreCasa, sesion } from '../stores/sesion.js';
import { conexion } from '../stores/conexion.js';
import { ui, abrirCasas } from '../stores/ui.js';

const nombre = computed(() => (vivienda.value ? nombreCasa.value : 'Sin vivienda'));
const pie = computed(() => (vivienda.value ? conexion.pie : ''));
const inicial = computed(() => {
  const u = sesion.value && sesion.value.usuario;
  return ((u && (u.nombre || u.email)) || '?').trim().charAt(0).toUpperCase();
});
</script>

<template>
  <header class="barra">
    <button class="vivienda-btn" aria-haspopup="dialog" @click="abrirCasas">
      <span>{{ nombre }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    <div class="barra-der">
      <div class="conexion" role="status">
        <span class="punto-vivo" :class="{ muerto: conexion.muerto }"></span><span>{{ pie }}</span>
      </div>
      <button type="button" class="cuenta-btn" aria-haspopup="dialog" aria-label="Abrir panel de cuenta y apariencia" @click="ui.panel = true">
        <span class="avatar" aria-hidden="true">{{ inicial }}</span>
        <span class="cuenta-texto">Cuenta</span>
      </button>
    </div>
  </header>
</template>
