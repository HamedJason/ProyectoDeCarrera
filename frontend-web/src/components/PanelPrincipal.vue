<script setup>
import { computed } from 'vue';
import BarraSuperior from './BarraSuperior.vue';
import AvisoConexion from './AvisoConexion.vue';
import BandasAviso from './BandasAviso.vue';
import EscenaEstado from './EscenaEstado.vue';
import GrupoSensores from './GrupoSensores.vue';
import TarjetaSirena from './TarjetaSirena.vue';
import SeccionCamara from './SeccionCamara.vue';
import AjustesLista from './AjustesLista.vue';
import HistorialLista from './HistorialLista.vue';
import ZonaPruebas from './ZonaPruebas.vue';
import DialogoSensor from './DialogoSensor.vue';
import DialogoCasas from './DialogoCasas.vue';
import DialogoGestion from './DialogoGestion.vue';
import DialogoFoto from './DialogoFoto.vue';
import DialogoVivo from './DialogoVivo.vue';
import PanelLateral from './PanelLateral.vue';
import HazAlarma from './HazAlarma.vue';
import { sensores, cargado, estado } from '../stores/casa.js';
import { vivienda } from '../stores/sesion.js';
import { abrirSensor } from '../stores/ui.js';

const contactos = computed(() => sensores.value.filter((s) => s.tipo !== 'movimiento'));
const movimiento = computed(() => sensores.value.filter((s) => s.tipo === 'movimiento'));
</script>

<template>
  <div id="app" class="envoltura">
    <Transition name="haz"><HazAlarma v-if="vivienda && estado.alarma_activa" /></Transition>
    <BarraSuperior />
    <AvisoConexion />
    <BandasAviso />
    <EscenaEstado />

    <GrupoSensores titulo="Puertas y ventanas" etiqueta="Puertas y ventanas" :sensores="contactos" />
    <GrupoSensores titulo="Movimiento" etiqueta="Sensores de movimiento" :sensores="movimiento" />

    <div v-if="vivienda && cargado && !sensores.length" class="sin-sensores">
      <strong>Todavía no hay sensores.</strong> Aparecen solos en cuanto un nodo se enciende cerca del concentrador,
      sin esperar a que alguien abra una puerta. Después decides si cada contacto es una puerta o una ventana.
      También puedes agregarlos a mano.
    </div>

    <button class="boton-texto agregar" @click="abrirSensor(null)">+ Agregar sensor</button>

    <TarjetaSirena />
    <SeccionCamara />

    <div class="columna">
      <AjustesLista />
      <HistorialLista />
      <ZonaPruebas />
    </div>

    <DialogoSensor />
    <DialogoCasas />
    <DialogoGestion />
    <DialogoFoto />
    <DialogoVivo />
    <PanelLateral />
  </div>
</template>
