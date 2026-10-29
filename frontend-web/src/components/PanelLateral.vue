<script setup>
import { computed } from 'vue';
import Hoja from './Hoja.vue';
import { ui, abrirCasas, abrirGestion } from '../stores/ui.js';
import { sesion, casaActual, esPropietario } from '../stores/sesion.js';
import { cerrarSesion } from '../stores/cuenta.js';
import { preferenciaTema, elegirTema, movimientoReducido, alternarMovimiento } from '../stores/tema.js';

const nombre = computed(() => (sesion.value ? sesion.value.usuario.nombre : ''));
const correo = computed(() => (sesion.value ? sesion.value.usuario.email : ''));
const inicial = computed(() => (nombre.value || correo.value || '?').trim().charAt(0).toUpperCase());
const rol = computed(() => {
  if (!casaActual.value) return 'Sin vivienda seleccionada';
  return (esPropietario.value ? 'Propietario' : 'Miembro') + ' · ' + casaActual.value.miembros +
    (casaActual.value.miembros === 1 ? ' persona' : ' personas');
});

const temas = [
  { valor: 'auto', texto: 'Sistema' },
  { valor: 'claro', texto: 'Claro' },
  { valor: 'oscuro', texto: 'Oscuro' }
];

// Cada acción cierra el panel y abre su hoja, para no apilar dos modales
function ir(abrir) { ui.panel = false; abrir(); }
function salir() { ui.panel = false; cerrarSesion(); }
</script>

<template>
  <Hoja v-model="ui.panel" titulo="panel-titulo" lateral>
    <div class="panel-cuerpo">
      <header class="panel-cab">
        <span class="avatar" aria-hidden="true">{{ inicial }}</span>
        <div class="panel-quien">
          <h3 id="panel-titulo">{{ nombre }}</h3>
          <p>{{ correo }}</p>
        </div>
        <button type="button" class="panel-cerrar" aria-label="Cerrar panel" @click="ui.panel = false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <section class="panel-bloque" aria-labelledby="panel-casa">
        <h4 id="panel-casa">Vivienda</h4>
        <p class="panel-dato"><strong>{{ casaActual ? casaActual.nombre : 'Sin vivienda' }}</strong><span>{{ rol }}</span></p>
        <button type="button" class="boton-texto panel-accion" @click="ir(abrirCasas)">Viviendas y contraseña</button>
        <button v-if="casaActual" type="button" class="boton-texto panel-accion" @click="ir(abrirGestion)">Miembros, invitaciones y dispositivos</button>
      </section>

      <section class="panel-bloque" aria-labelledby="panel-apariencia">
        <h4 id="panel-apariencia">Apariencia</h4>
        <fieldset class="temas">
          <legend>Tema</legend>
          <label v-for="t in temas" :key="t.valor">
            <input type="radio" name="tema" :value="t.valor" :checked="preferenciaTema === t.valor" @change="elegirTema(t.valor)">
            <span>{{ t.texto }}</span>
          </label>
        </fieldset>
        <div class="fila panel-fila">
          <div>
            <div class="titulo">Reducir animaciones</div>
            <div class="nota">Detiene el movimiento de las ilustraciones y el giro del haz de alarma</div>
          </div>
          <button
            type="button" class="interruptor" :class="{ activo: movimientoReducido }" role="switch"
            :aria-checked="String(movimientoReducido)" aria-label="Reducir animaciones" @click="alternarMovimiento"
          ></button>
        </div>
      </section>

      <footer class="panel-pie">
        <button type="button" class="boton secundario" @click="salir">Cerrar sesión</button>
        <p>Sentinel Home<br>Proyecto de Carrera, UABC FCQI</p>
      </footer>
    </div>
  </Hoja>
</template>
