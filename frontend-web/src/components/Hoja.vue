<!-- Hoja modal: envuelve <dialog> y se controla con v-model (abierta o cerrada) -->
<script setup>
import { ref, watch, onMounted } from 'vue';

const props = defineProps({ modelValue: Boolean, titulo: { type: String, default: '' }, lateral: Boolean });
const emit = defineEmits(['update:modelValue', 'cerrado']);
const el = ref(null);

function abrir() {
  const d = el.value;
  if (!d) return;
  if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
}
function cerrar() {
  const d = el.value;
  if (!d) return;
  if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open');
}

watch(() => props.modelValue, (v) => (v ? abrir() : cerrar()), { flush: 'post' });
onMounted(() => { if (props.modelValue) abrir(); });

// En el panel lateral, tocar fuera (el fondo) lo cierra
function alTocar(e) {
  if (props.lateral && e.target === el.value) emit('update:modelValue', false);
}

// Tambien se dispara con Escape o al cerrar desde dentro
function alCerrar() {
  emit('update:modelValue', false);
  emit('cerrado');
}
</script>

<template>
  <dialog ref="el" class="hoja" :class="{ lateral }" :aria-labelledby="titulo || undefined" @close="alCerrar" @click="alTocar">
    <slot />
  </dialog>
</template>
