<!-- La sirena refleja la alarma real o la prueba manual -->
<script setup>
import { computed } from 'vue';
import { estado } from '../stores/casa.js';

const sonando = computed(() => !!estado.value.alarma_activa);
const prueba = computed(() => !sonando.value && !!estado.value.actuador_activo);
const lectura = computed(() => (sonando.value ? 'Sonando' : (prueba.value ? 'Prueba en curso' : 'En espera')));
const cuando = computed(() => (sonando.value ? (estado.value.alarma_motivo || '') : (estado.value.armado ? 'Vigilando' : '')));
</script>

<template>
  <section aria-label="Sirena">
    <div class="grupo-cab"><h2>Sirena</h2></div>
    <div class="rejilla">
      <div class="tarjeta sirena" :class="{ sonando, prueba }">
        <div class="ilu">
          <div class="si">
            <span class="haz"></span>
            <div class="cuerpo">
              <i class="ond i"></i><i class="ond i b"></i><i class="ond d"></i><i class="ond d b"></i>
              <div class="domo"></div>
              <div class="base"></div>
              <span class="led"></span>
            </div>
          </div>
        </div>
        <div class="nombre">Sirena</div>
        <div class="lectura">{{ lectura }}</div>
        <div class="cuando">{{ cuando }}</div>
      </div>
    </div>
  </section>
</template>
