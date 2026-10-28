<!-- Hoja modal: envuelve <dialog> y se controla con v-model (abierta o cerrada) -->
<script setup>
import { ref, watch, onMounted } from 'vue';

const props = defineProps({ modelValue: Boolean, titulo: { type: String, default: '' } });
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

// Tambien se dispara con Escape o al cerrar desde dentro
function alCerrar() {
  emit('update:modelValue', false);
  emit('cerrado');
}
</script>

<template>
  <dialog ref="el" class="hoja" :aria-labelledby="titulo || undefined" @close="alCerrar">
    <slot />
  </dialog>
</template>
