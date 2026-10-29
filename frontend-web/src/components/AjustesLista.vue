<script setup>
import { estado, alternarSilencio, alternarSirena } from '../stores/casa.js';
import { avisosActivos, notaAvisos, conPush, textoPrueba, alternarAvisos, probarPush } from '../stores/avisos.js';
import { abrirGestion } from '../stores/ui.js';
</script>

<template>
  <section aria-label="Ajustes">
    <div class="fila">
      <div>
        <div class="titulo">Modo silencioso</div>
        <div class="nota">Registra y notifica sin encender la sirena</div>
      </div>
      <button
        class="interruptor" :class="{ activo: estado.modo_silencioso }" role="switch"
        :aria-checked="String(!!estado.modo_silencioso)" aria-label="Modo silencioso" @click="alternarSilencio"
      ></button>
    </div>
    <div class="fila">
      <div>
        <div class="titulo">Avisos en este dispositivo</div>
        <div class="nota">{{ notaAvisos }}</div>
      </div>
      <button
        class="interruptor" :class="{ activo: avisosActivos }" role="switch"
        :aria-checked="String(avisosActivos)" aria-label="Avisos en este dispositivo" @click="alternarAvisos"
      ></button>
    </div>
    <div v-if="conPush" class="fila">
      <div>
        <div class="titulo">Probar notificación</div>
        <div class="nota">Envía una notificación push a este dispositivo</div>
      </div>
      <button class="boton-texto" @click="probarPush">{{ textoPrueba }}</button>
    </div>
    <div class="fila">
      <div>
        <div class="titulo">Vivienda</div>
        <div class="nota">Miembros, invitaciones y dispositivos</div>
      </div>
      <button class="boton-texto" @click="abrirGestion">Administrar</button>
    </div>
    <div class="fila">
      <div>
        <div class="titulo">Probar la sirena</div>
        <div class="nota">Enciende la salida sin necesidad de una alarma</div>
      </div>
      <button class="boton-texto" :class="{ activa: estado.actuador_activo }" @click="alternarSirena">{{ estado.actuador_activo ? 'Apagar' : 'Encender' }}</button>
    </div>
  </section>
</template>
