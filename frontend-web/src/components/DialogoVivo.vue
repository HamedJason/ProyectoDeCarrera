<!-- Vista en vivo de la camara -->
<script setup>
import { ref, watch, onBeforeUnmount } from 'vue';
import Hoja from './Hoja.vue';
import { ui } from '../stores/ui.js';
import { vivienda } from '../stores/sesion.js';
import { enviarJson, pedir, ErrorSesion, mensajeDeError } from '../api/cliente.js';
import { formatoMinSeg } from '../utils/formato.js';

const imagen = ref(null);
const src = ref(null);
const sobreVisible = ref(true);
const sobre = ref('Conectando con la cámara');
const info = ref('');

let activo = false;
let temporizador = null;
let espera = null;

watch(() => ui.vivo, (abierto) => { if (abierto) abrir(); });

async function abrir() {
  info.value = '';
  sobreVisible.value = true;
  sobre.value = 'Conectando con la cámara';
  src.value = null;
  try {
    const r = await enviarJson('/camara/vivo/iniciar', 'POST', { vivienda_id: vivienda.value });
    if (!r.ok) { sobre.value = r.datos.mensaje || 'No se pudo iniciar la vista en vivo.'; return; }
    activo = true;
    src.value = '/camara/vivo?vivienda_id=' + encodeURIComponent(vivienda.value) + '&t=' + Date.now();
    // En un flujo multipart el evento load no es fiable; se comprueba si ya hay imagen
    let intentos = 0;
    espera = setInterval(() => {
      intentos++;
      if (imagen.value && imagen.value.naturalWidth > 0) { sobreVisible.value = false; clearInterval(espera); espera = null; }
      else if (intentos === 16) sobre.value = 'Esperando imagen. Revisa que la cámara esté encendida y con Wi-Fi.';
    }, 500);
    temporizador = setInterval(vigilar, 2000);
  } catch (e) {
    if (!(e instanceof ErrorSesion)) sobre.value = mensajeDeError(e);
  }
}

async function vigilar() {
  try {
    const c = await pedir('/camara/estado?vivienda_id=' + encodeURIComponent(vivienda.value));
    if (!c) return;
    if (!c.vivo.activo) { terminar('La sesión terminó. Se alcanzó el tiempo máximo o se cerró desde otro dispositivo.'); return; }
    info.value = 'Quedan ' + formatoMinSeg(c.vivo.restante_s) + ' de esta sesión · hoy llevas ' +
      Math.round(c.cuota.usado_min) + ' de ' + c.cuota.max_min + ' min';
  } catch (e) { /* un fallo aislado no cierra la vista */ }
}

function terminar(mensaje) {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
  if (espera) { clearInterval(espera); espera = null; }
  activo = false;
  src.value = null;   // corta la conexion del flujo
  sobreVisible.value = true;
  sobre.value = mensaje || '';
}

function alCerrar() {
  if (activo && vivienda.value) {
    enviarJson('/camara/vivo/detener', 'POST', { vivienda_id: vivienda.value }).catch(() => {});
  }
  terminar('');
}

onBeforeUnmount(() => terminar(''));
</script>

<template>
  <Hoja v-model="ui.vivo" titulo="vivo-titulo" @cerrado="alCerrar">
    <div class="hoja-cuerpo">
      <h3 id="vivo-titulo">En vivo</h3>
      <div class="visor">
        <img ref="imagen" :src="src || undefined" alt="Vista en vivo de la cámara">
        <div v-show="sobreVisible" class="sobre">{{ sobre }}</div>
      </div>
      <p class="nota">{{ info }}</p>
      <button type="button" class="boton secundario" @click="ui.vivo = false">Detener y cerrar</button>
    </div>
  </Hoja>
</template>
