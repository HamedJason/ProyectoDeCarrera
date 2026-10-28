<!-- Solo aparece cuando el servidor esta en modo de pruebas -->
<script setup>
import { ref } from 'vue';
import BotonDosToques from './BotonDosToques.vue';
import { pedirJson, ErrorSesion, mensajeDeError } from '../api/cliente.js';
import { vivienda } from '../stores/sesion.js';
import { refrescar } from '../stores/casa.js';
import { modoPruebas } from '../stores/avisos.js';
import { mostrarAviso } from '../stores/conexion.js';

const borrando = ref(false);

async function limpiar() {
  borrando.value = true;
  try {
    await pedirJson('/limpiar', { vivienda_id: vivienda.value, que: 'todo' });
    await refrescar(true);
  } catch (e) {
    if (!(e instanceof ErrorSesion)) mostrarAviso(mensajeDeError(e));
  } finally {
    borrando.value = false;
  }
}
</script>

<template>
  <div id="zona-pruebas" :class="{ visible: modoPruebas }">
    <BotonDosToques texto-confirmar="Toca de nuevo para confirmar" :deshabilitado="borrando" @confirmado="limpiar">
      {{ borrando ? 'Borrando' : 'Borrar historial' }}
    </BotonDosToques>
    <div class="nota">Solo disponible en modo de pruebas</div>
  </div>
</template>
