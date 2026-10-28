<!-- Raiz: decide entre la pantalla de acceso y la aplicacion, y arranca la sesion -->
<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import AccesoView from './components/AccesoView.vue';
import PanelPrincipal from './components/PanelPrincipal.vue';
import { pantalla, vivienda } from './stores/sesion.js';
import { arrancar } from './stores/cuenta.js';
import { refrescar } from './stores/casa.js';
import { refrescarCamara } from './stores/camara.js';

// Al volver a la aplicacion tras dejarla en segundo plano, actualizar de inmediato
function alVolver() {
  if (!document.hidden && vivienda.value) { refrescar(); refrescarCamara(); }
}

onMounted(() => {
  arrancar();
  document.addEventListener('visibilitychange', alVolver);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', alVolver));
</script>

<template>
  <AccesoView />
  <PanelPrincipal v-if="pantalla === 'app'" />
</template>
