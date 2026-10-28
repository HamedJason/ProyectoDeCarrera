<!-- Boton que pide un segundo toque antes de ejecutar algo delicado, sin usar cuadros de dialogo -->
<script setup>
import { ref, onBeforeUnmount } from 'vue';

const props = defineProps({
  textoConfirmar: { type: String, default: 'Toca de nuevo' },
  clase: { type: String, default: 'boton-texto' },
  tiempo: { type: Number, default: 4000 },
  deshabilitado: Boolean
});
const emit = defineEmits(['confirmado']);
const pendiente = ref(false);
let reloj = null;

function reiniciar() {
  if (reloj) { clearTimeout(reloj); reloj = null; }
  pendiente.value = false;
}

function tocar() {
  if (pendiente.value) { reiniciar(); emit('confirmado'); return; }
  pendiente.value = true;
  reloj = setTimeout(reiniciar, props.tiempo);
}

onBeforeUnmount(reiniciar);
defineExpose({ reiniciar });
</script>

<template>
  <button type="button" :class="[clase, { confirmar: pendiente }]" :disabled="deshabilitado" @click="tocar">
    <template v-if="pendiente">{{ textoConfirmar }}</template>
    <slot v-else />
  </button>
</template>
