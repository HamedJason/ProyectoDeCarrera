<!-- Grupo de tarjetas de sensores (puertas y ventanas, o movimiento) -->
<script setup>
import TarjetaSensor from './TarjetaSensor.vue';
defineProps({
  titulo: { type: String, required: true },
  etiqueta: { type: String, required: true },
  sensores: { type: Array, required: true }
});
</script>

<template>
  <section v-if="sensores.length" class="grupo" :aria-label="etiqueta">
    <div class="grupo-cab"><h2>{{ titulo }}</h2><span class="cuenta">{{ sensores.length }}</span></div>
    <div class="rejilla">
      <TarjetaSensor v-for="s in sensores" :key="s.id" :sensor="s" />
    </div>
  </section>
</template>
