<script setup>
import { computed } from 'vue';
import { estado, sensores, nodos } from '../stores/casa.js';
import { abrirSensor, abrirGestion } from '../stores/ui.js';
import { hace } from '../utils/formato.js';

const nuevos = computed(() => sensores.value.filter((s) => s.confirmado === false));
const textoNuevos = computed(() => (nuevos.value.length === 1
  ? 'Detectamos un sensor nuevo. Ponle nombre y elige si es puerta o ventana.'
  : 'Detectamos ' + nuevos.value.length + ' sensores nuevos. Ponles nombre y elige si son puertas o ventanas.'));

const textoHub = computed(() => {
  if (estado.value.hub_en_linea !== false) return '';
  return estado.value.hub_visto
    ? 'El concentrador no se comunica con el servidor desde ' + hace(estado.value.hub_visto) +
      '. Mientras tanto la alarma no puede avisar.'
    : 'Todavía no se conecta ningún concentrador. En Dispositivos está el token que debe llevar.';
});

const caidos = computed(() => nodos.value.filter((n) => !n.en_linea));
const textoNodos = computed(() => {
  if (!caidos.value.length || estado.value.hub_en_linea === false) return '';
  return caidos.value.length === 1
    ? 'El nodo ' + caidos.value[0].nodo_id + ' no responde (última señal ' + hace(caidos.value[0].ultimo_visto) + '). Revisa su alimentación.'
    : caidos.value.length + ' nodos no responden. Revisa su alimentación.';
});

function revisarNuevos() {
  if (nuevos.value.length) abrirSensor(nuevos.value[0]);
}
</script>

<template>
  <div v-if="textoHub" class="banda roja" role="status">
    <span>{{ textoHub }}</span>
    <button type="button" @click="abrirGestion">Dispositivos</button>
  </div>
  <div v-if="textoNodos" class="banda" role="status"><span>{{ textoNodos }}</span></div>
  <div v-if="nuevos.length" class="banda" role="status">
    <span>{{ textoNuevos }}</span>
    <button type="button" @click="revisarNuevos">Revisar</button>
  </div>
</template>
