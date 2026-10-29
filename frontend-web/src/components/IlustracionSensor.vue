<!-- Ilustracion de cada sensor solo con HTML y CSS. Nunca cambia de clases: el movimiento lo define la hoja de
     estilos segun las clases de la tarjeta que lo contiene (abierta, actividad, disparado...). -->
<script setup>
import CieloNoche from './CieloNoche.vue';
defineProps({ tipo: { type: String, required: true } });
</script>

<template>
  <div v-if="tipo === 'puerta'" class="pu">
    <div class="marco"></div>
    <div class="vano noche"><CieloNoche /></div>
    <div class="giro"><div class="cara"><span class="brillo"></span><span class="pomo"></span></div></div>
    <span class="suelo"></span><span class="led"></span>
  </div>

  <div v-else-if="tipo === 'ventana'" class="vn">
    <div class="marco noche">
      <CieloNoche />
      <span class="cortina i"></span><span class="cortina d"></span>
    </div>
    <div class="hoja i"><div class="cara"><span class="brillo"></span></div></div>
    <div class="hoja d"><div class="cara"><span class="brillo"></span></div></div>
    <span class="repisa"></span><span class="led"></span>
  </div>

  <div v-else class="pr">
    <div class="placa"></div><span class="led"></span>
    <i class="barrido"></i><i class="barrido b"></i>
    <i class="onda"></i><i class="onda b"></i><i class="onda c"></i>
    <div class="domo"><span class="calor"></span></div>
  </div>
</template>
