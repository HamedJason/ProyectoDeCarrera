<!-- Visor de una foto de la camara -->
<script setup>
import { ref, computed, watch } from 'vue';
import Hoja from './Hoja.vue';
import BotonDosToques from './BotonDosToques.vue';
import { ui } from '../stores/ui.js';
import { esPropietario } from '../stores/sesion.js';
import { refrescarCamara } from '../stores/camara.js';
import { enviarJson, ErrorSesion, mensajeDeError } from '../api/cliente.js';
import { formatearFecha } from '../utils/formato.js';

const f = computed(() => ui.fotoAbierta);
const error = ref('');
watch(() => ui.foto, (abierto) => { if (abierto) error.value = ''; });

const info = computed(() => error.value ||
  (f.value ? formatearFecha(f.value.creado_en) + ' · ' + Math.round(f.value.bytes / 1024) + ' KB' : ''));

async function borrar() {
  if (!f.value) return;
  try {
    const r = await enviarJson('/fotos/' + f.value.id, 'DELETE', {});
    if (!r.ok) { error.value = r.datos.mensaje || 'No se pudo eliminar.'; return; }
    ui.foto = false;
    refrescarCamara();
  } catch (e) { if (!(e instanceof ErrorSesion)) error.value = mensajeDeError(e); }
}
</script>

<template>
  <Hoja v-model="ui.foto" titulo="foto-titulo">
    <div class="hoja-cuerpo">
      <h3 id="foto-titulo">{{ f && f.motivo ? f.motivo : 'Foto' }}</h3>
      <div class="visor"><img :src="f ? '/fotos/' + f.id + '/imagen' : undefined" alt="Foto de la cámara"></div>
      <p class="nota">{{ info }}</p>
      <div class="grid2">
        <button type="button" class="boton secundario" @click="ui.foto = false">Cerrar</button>
        <BotonDosToques v-if="esPropietario" clase="boton secundario" texto-confirmar="Toca de nuevo" @confirmado="borrar">
          <span style="color:var(--sirena)">Eliminar</span>
        </BotonDosToques>
      </div>
    </div>
  </Hoja>
</template>
