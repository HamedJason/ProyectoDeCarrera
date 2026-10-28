<!--
  Historial como linea de tiempo. Se muestra resumido (los ultimos eventos) y se
  despliega bajo demanda, para que la pantalla principal no se alargue con el uso.
-->
<script setup>
import { ref, computed } from 'vue';
import { hitos, cargado } from '../stores/casa.js';
import { formatearFecha } from '../utils/formato.js';

const RESUMEN = 5;
let guardado = false;
try { guardado = localStorage.getItem('historial_desplegado') === '1'; } catch (_) { /* sin almacenamiento */ }
const desplegado = ref(guardado);
const lista = ref(null);

const visibles = computed(() => (desplegado.value ? hitos.value : hitos.value.slice(0, RESUMEN)));
const hayMas = computed(() => hitos.value.length > RESUMEN);

function alternar() {
  desplegado.value = !desplegado.value;
  try { localStorage.setItem('historial_desplegado', desplegado.value ? '1' : '0'); } catch (_) { /* sin almacenamiento */ }
  if (!desplegado.value && lista.value) lista.value.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <h2 style="margin-top:34px">Historial</h2>
  <ol ref="lista" class="linea">
    <li v-if="!cargado" class="cargando">Consultando el servidor</li>
    <li v-else-if="!hitos.length" class="vacio">Todavía no hay eventos. Abre una puerta o pasa frente a un sensor para generar el primero.</li>
    <template v-else>
      <li v-for="(h, i) in visibles" :key="h.t + h.titulo + i" class="hito" :class="h.clase">
        <div class="riel"><span class="marca"></span></div>
        <div class="texto">
          <div class="quien">{{ h.titulo }}</div>
          <div class="cuando">{{ formatearFecha(h.t) }}{{ h.detalle }}</div>
        </div>
      </li>
    </template>
  </ol>
  <button v-if="hayMas" class="historial-mas" @click="alternar">
    {{ desplegado ? 'Mostrar menos' : 'Ver todo el historial (' + hitos.length + ')' }}
  </button>
</template>
