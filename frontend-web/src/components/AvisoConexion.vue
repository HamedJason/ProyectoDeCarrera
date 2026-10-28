<!-- Aviso cuando falla la comunicacion con el servidor -->
<script setup>
import { conexion } from '../stores/conexion.js';
import { refrescar } from '../stores/casa.js';
</script>

<template>
  <div id="aviso" role="alert" :class="{ visible: conexion.visible }">
    <div id="aviso-texto">{{ conexion.aviso }}</div>
    <button @click="refrescar(true)">Reintentar</button>
  </div>
</template>
