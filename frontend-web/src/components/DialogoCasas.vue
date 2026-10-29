<script setup>
import { ref, watch } from 'vue';
import Hoja from './Hoja.vue';
import { ui } from '../stores/ui.js';
import { sesion, vivienda } from '../stores/sesion.js';
import { elegirVivienda, crearCasa, unirseConCodigo, cambiarClave, cerrarSesion } from '../stores/cuenta.js';

const nueva = ref('');
const codigo = ref('');
const claveActual = ref('');
const claveNueva = ref('');
const verClave = ref(false);
const mensaje = ref('');
const exito = ref(false);

watch(() => ui.casas, (abierto) => { if (abierto) { mensaje.value = ''; exito.value = false; } });

function error(t) { mensaje.value = t; exito.value = false; }

async function crear() {
  error('');
  const r = await crearCasa(nueva.value.trim());
  if (r) error(r); else nueva.value = '';
}

async function unirse() {
  error('');
  const r = await unirseConCodigo(codigo.value.trim());
  if (r) error(r); else codigo.value = '';
}

async function guardarClave() {
  error('');
  const r = await cambiarClave(claveActual.value, claveNueva.value);
  if (!r.ok) { error(r.mensaje); return; }
  claveActual.value = ''; claveNueva.value = '';
  verClave.value = false;
  mensaje.value = r.mensaje; exito.value = true;
  setTimeout(() => { exito.value = false; mensaje.value = ''; }, 3000);
}
</script>

<template>
  <Hoja v-model="ui.casas" titulo="casas-titulo">
    <div class="hoja-cuerpo">
      <h3 id="casas-titulo">Tus viviendas</h3>
      <div class="lista-casas">
        <template v-if="sesion && sesion.viviendas.length">
          <button
            v-for="v in sesion.viviendas" :key="v.id" type="button"
            class="casa" :class="{ actual: v.id === vivienda }" @click="elegirVivienda(v.id)"
          >
            <span>
              <span class="n">{{ v.nombre }}</span><br>
              <span class="r">{{ v.rol === 'propietario' ? 'Propietario' : 'Miembro' }} · {{ v.miembros }} {{ v.miembros === 1 ? 'persona' : 'personas' }}</span>
            </span>
            <span class="r">{{ v.id === vivienda ? 'Actual' : '' }}</span>
          </button>
        </template>
        <p v-else class="nota">Todavía no tienes viviendas.</p>
      </div>

      <form class="en-linea" @submit.prevent="crear">
        <label class="campo"><span>Nueva vivienda</span><input v-model="nueva" type="text" maxlength="50" autocomplete="off" placeholder="Ej. Casa de la playa"></label>
        <button type="submit" class="boton armar">Crear</button>
      </form>
      <form class="en-linea" @submit.prevent="unirse">
        <label class="campo"><span>Unirme con un código de invitación</span><input v-model="codigo" type="text" maxlength="12" autocomplete="off" placeholder="XXXX-XXXX" style="text-transform:uppercase"></label>
        <button type="submit" class="boton secundario">Unirme</button>
      </form>
      <p class="error-msg" :class="{ visible: !!mensaje }" :style="exito ? { color: 'var(--pino)' } : null" role="alert">{{ mensaje }}</p>

      <form v-show="verClave" style="padding:0" @submit.prevent="guardarClave">
        <h4>Cambiar contraseña</h4>
        <label class="campo"><span>Contraseña actual</span><input v-model="claveActual" type="password" autocomplete="current-password" required></label>
        <label class="campo"><span>Contraseña nueva (mínimo 8 caracteres)</span><input v-model="claveNueva" type="password" autocomplete="new-password" required minlength="8"></label>
        <button type="submit" class="boton armar">Guardar contraseña</button>
      </form>

      <div class="cuenta-caja">
        <div class="quien">{{ sesion ? sesion.usuario.nombre + ' · ' + sesion.usuario.email : '' }}</div>
        <button type="button" class="boton-texto" @click="verClave = !verClave">Cambiar contraseña</button>
        <button type="button" class="boton-texto" @click="cerrarSesion">Cerrar sesión</button>
      </div>
      <button type="button" class="boton secundario" @click="ui.casas = false">Cerrar</button>
    </div>
  </Hoja>
</template>
