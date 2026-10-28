<!-- Administracion de la vivienda actual: nombre, miembros, invitaciones, token de dispositivos y borrado -->
<script setup>
import { ref, watch } from 'vue';
import Hoja from './Hoja.vue';
import BotonDosToques from './BotonDosToques.vue';
import { ui } from '../stores/ui.js';
import { casaActual, nombreCasa, esPropietario } from '../stores/sesion.js';
import {
  cargarMiembros, quitarMiembro, renombrarCasa, crearInvitacion, generarToken, eliminarCasa
} from '../stores/cuenta.js';
import { ErrorSesion, mensajeDeError } from '../api/cliente.js';

const nombre = ref('');
const miembros = ref(null);          // { miembros, soy } o texto de error
const errorMiembros = ref('');
const invitacion = ref(null);        // { codigo, horas }
const token = ref('');
const estadoToken = ref('');
const confirmar = ref('');
const error = ref('');
const copiado = ref('Copiar token');
const cajaToken = ref(null);
const origen = location.origin;

watch(() => ui.gestion, (abierto) => {
  if (!abierto || !casaActual.value) return;
  nombre.value = casaActual.value.nombre;
  estadoToken.value = casaActual.value.tiene_token
    ? 'Esta vivienda tiene su propio token. Si generas uno nuevo, el anterior deja de funcionar y hay que actualizar el firmware.'
    : 'Esta vivienda todavía usa el token global del servidor. Genera uno propio para que cada vivienda tenga el suyo.';
  token.value = ui.tokenPendiente || '';
  ui.tokenPendiente = null;
  invitacion.value = null;
  confirmar.value = '';
  error.value = '';
  copiado.value = 'Copiar token';
  cargar();
});

async function cargar() {
  errorMiembros.value = '';
  try {
    miembros.value = await cargarMiembros();
  } catch (e) {
    if (!(e instanceof ErrorSesion)) errorMiembros.value = mensajeDeError(e);
  }
}

async function quitar(m, esYo) {
  error.value = '';
  const r = await quitarMiembro(m.usuario_id, esYo);
  if (r) error.value = r; else if (!esYo) await cargar();
}

async function renombrar() {
  error.value = await renombrarCasa(nombre.value.trim());
}

async function invitar() {
  error.value = '';
  const r = await crearInvitacion();
  if (r.error !== undefined) { error.value = r.error; return; }
  invitacion.value = r;
}

async function nuevoToken() {
  error.value = '';
  const r = await generarToken();
  if (r.error !== undefined) { error.value = r.error; return; }
  token.value = r.token;
  if (casaActual.value) casaActual.value.tiene_token = true;
  estadoToken.value = 'Token nuevo generado. El anterior ya no funciona.';
}

async function copiar() {
  try {
    await navigator.clipboard.writeText(token.value);
    copiado.value = 'Copiado';
  } catch (e) {
    const r = document.createRange(); r.selectNodeContents(cajaToken.value);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    copiado.value = 'Selecciónalo y cópialo';
  }
  setTimeout(() => { copiado.value = 'Copiar token'; }, 2500);
}

async function eliminar() {
  error.value = '';
  error.value = await eliminarCasa(confirmar.value);
}
</script>

<template>
  <Hoja v-model="ui.gestion" titulo="gestion-titulo">
    <div class="hoja-cuerpo">
      <h3 id="gestion-titulo">{{ nombreCasa }}</h3>

      <form v-if="esPropietario" class="en-linea" style="padding:0" @submit.prevent="renombrar">
        <label class="campo"><span>Nombre</span><input v-model="nombre" type="text" maxlength="50" autocomplete="off"></label>
        <button type="submit" class="boton secundario">Guardar</button>
      </form>

      <hr>
      <h4>Miembros</h4>
      <div>
        <template v-if="miembros">
          <div v-for="m in miembros.miembros" :key="m.usuario_id" class="fila-miembro">
            <div>
              {{ m.nombre }}{{ m.usuario_id === miembros.soy ? ' (tú)' : '' }}
              <div class="r">{{ m.email }} · {{ m.rol === 'propietario' ? 'Propietario' : 'Miembro' }}</div>
            </div>
            <BotonDosToques
              v-if="m.usuario_id === miembros.soy" clase="" texto-confirmar="Toca de nuevo"
              @confirmado="quitar(m, true)"
            >Salir</BotonDosToques>
            <BotonDosToques
              v-else-if="esPropietario" clase="" texto-confirmar="Toca de nuevo"
              @confirmado="quitar(m, false)"
            >Quitar</BotonDosToques>
          </div>
        </template>
        <template v-else>{{ errorMiembros }}</template>
      </div>
      <div v-if="esPropietario">
        <button type="button" class="boton-texto" @click="invitar">Crear código de invitación</button>
        <div v-if="invitacion" style="margin-top:10px">
          <div class="codigo">{{ invitacion.codigo }}</div>
          <p class="nota" style="margin-top:6px">
            Sirve una sola vez y caduca en {{ invitacion.horas }} horas. Quien lo reciba puede abrir
            {{ origen }}/?codigo={{ invitacion.codigo }} para crear su cuenta, o escribirlo en “Unirme con un código”.
          </p>
        </div>
      </div>

      <hr>
      <h4>Dispositivos (concentrador y cámara)</h4>
      <p class="nota">{{ estadoToken }}</p>
      <div v-if="esPropietario">
        <BotonDosToques texto-confirmar="Toca de nuevo: el actual dejará de funcionar" @confirmado="nuevoToken">Generar token nuevo</BotonDosToques>
      </div>
      <div v-if="token" class="caja-token">
        <div ref="cajaToken" class="token">{{ token }}</div>
        <p class="nota" style="margin-top:6px">Cópialo ahora, no se vuelve a mostrar. Pégalo en <b>DEVICE_TOKEN</b> del firmware del concentrador y de la cámara. En <b>BACKEND_BASE</b> va la dirección del servidor, con http y el puerto del concentrador.</p>
        <button type="button" class="boton-texto" style="margin-top:8px" @click="copiar">{{ copiado }}</button>
      </div>

      <div v-if="esPropietario">
        <hr>
        <h4>Eliminar vivienda</h4>
        <p class="nota">Borra la vivienda con sus sensores, historial y fotos. No se puede deshacer.</p>
        <form style="padding:0" @submit.prevent="eliminar">
          <label class="campo"><span>Escribe el nombre exacto para confirmar</span><input v-model="confirmar" type="text" autocomplete="off"></label>
          <button type="submit" class="boton-eliminar" style="justify-self:start;padding:0">Eliminar esta vivienda</button>
        </form>
      </div>

      <p class="error-msg" :class="{ visible: !!error }" role="alert">{{ error }}</p>
      <button type="button" class="boton secundario" @click="ui.gestion = false">Cerrar</button>
    </div>
  </Hoja>
</template>
