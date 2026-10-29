<script setup>
import { reactive, ref, computed, watch, nextTick } from 'vue';
import Hoja from './Hoja.vue';
import BotonDosToques from './BotonDosToques.vue';
import { ui } from '../stores/ui.js';
import { vivienda } from '../stores/sesion.js';
import { refrescar } from '../stores/casa.js';
import { enviarJson, ErrorSesion, mensajeDeError } from '../api/cliente.js';

const editando = computed(() => ui.sensorEditado);
const form = reactive({ nombre: '', zona: '', id: '', tipo: 'puerta' });
const error = ref('');
const guardando = ref(false);
const botonEliminar = ref(null);
const entradaNombre = ref(null);

const titulo = computed(() => (editando.value
  ? (editando.value.confirmado === false ? 'Sensor nuevo' : 'Editar sensor')
  : 'Agregar sensor'));

const ayuda = computed(() => {
  const s = editando.value;
  if (!s) return 'Usa el mismo identificador que el firmware (sensorId). Si el nodo aún no lo reporta, la tarjeta dirá "Sin datos".';
  return (s.confirmado === false ? 'Detectado automáticamente. Ponle un nombre y confirma qué es. ' : '') +
    'Identificador: ' + s.sensor_id + (s.nodo_id ? ' · nodo ' + s.nodo_id : '') +
    (s.variable ? '. Un contacto puede ser puerta o ventana; un detector solo movimiento.' : '');
});

const TIPOS = [
  { valor: 'puerta', texto: 'Puerta' },
  { valor: 'ventana', texto: 'Ventana' },
  { valor: 'movimiento', texto: 'Movimiento' }
];

// Un contacto solo puede ser puerta o ventana, y un detector solo movimiento
function deshabilitado(valor) {
  const variable = editando.value ? editando.value.variable : null;
  const esMov = valor === 'movimiento';
  return (variable === 'estado_puerta' && esMov) || (variable === 'movimiento' && !esMov);
}

watch(() => ui.sensor, async (abierto) => {
  if (!abierto) return;
  const s = editando.value;
  form.nombre = s ? s.nombre : '';
  form.zona = s && s.zona ? s.zona : '';
  form.id = '';
  form.tipo = s ? s.tipo : 'puerta';
  error.value = '';
  guardando.value = false;
  if (botonEliminar.value) botonEliminar.value.reiniciar();
  await nextTick();
  if (entradaNombre.value) entradaNombre.value.focus();
});

function cerrar() { ui.sensor = false; }

async function guardar() {
  const nombre = form.nombre.trim();
  const zona = form.zona.trim();
  error.value = '';
  if (!editando.value && !form.id.trim()) { error.value = 'Escribe el identificador del sensor.'; return; }
  if (!form.tipo) { error.value = 'Elige si es puerta, ventana o movimiento.'; return; }

  guardando.value = true;
  try {
    const r = editando.value
      ? await enviarJson('/sensores/' + editando.value.id, 'PATCH', { nombre, tipo: form.tipo, zona })
      : await enviarJson('/sensores', 'POST', { vivienda_id: vivienda.value, sensor_id: form.id.trim(), nombre, tipo: form.tipo, zona });
    if (!r.ok) {
      error.value = (r.datos && (r.datos.mensaje || (r.datos.errores || []).join(' '))) || 'No se pudo guardar.';
      guardando.value = false;
      return;
    }
    cerrar();
    await refrescar(true);
  } catch (e) {
    if (e instanceof ErrorSesion) return;
    error.value = mensajeDeError(e);
    guardando.value = false;
  }
}

// Dos toques para no eliminar por accidente
async function eliminar() {
  if (!editando.value) return;
  try {
    const r = await enviarJson('/sensores/' + editando.value.id, 'DELETE', {});
    if (!r.ok) { error.value = (r.datos && r.datos.mensaje) || 'No se pudo eliminar.'; return; }
    cerrar();
    await refrescar(true);
  } catch (e) {
    error.value = mensajeDeError(e);
  }
}
</script>

<template>
  <Hoja v-model="ui.sensor" titulo="dlg-titulo">
    <form @submit.prevent="guardar">
      <h3 id="dlg-titulo">{{ titulo }}</h3>
      <div>
        <label for="dlg-nombre">Nombre</label>
        <input id="dlg-nombre" ref="entradaNombre" v-model="form.nombre" type="text" maxlength="60" autocomplete="off" placeholder="Ej. Puerta de la cocina">
      </div>
      <fieldset>
        <legend>Tipo</legend>
        <div class="tipos">
          <label v-for="t in TIPOS" :key="t.valor">
            <input v-model="form.tipo" type="radio" name="tipo" :value="t.valor" :disabled="deshabilitado(t.valor)"><span>{{ t.texto }}</span>
          </label>
        </div>
      </fieldset>
      <div>
        <label for="dlg-zona">Zona</label>
        <input id="dlg-zona" v-model="form.zona" type="text" maxlength="40" autocomplete="off" placeholder="Ej. cocina">
      </div>
      <div v-if="!editando">
        <label for="dlg-id">Identificador del sensor</label>
        <input id="dlg-id" v-model="form.id" type="text" maxlength="60" autocomplete="off" placeholder="El mismo que usa el firmware">
      </div>
      <p class="ayuda">{{ ayuda }}</p>
      <p class="error" :class="{ visible: !!error }" role="alert">{{ error }}</p>
      <div class="dlg-botones">
        <button type="button" class="boton secundario" @click="cerrar">Cancelar</button>
        <button type="submit" class="boton armar" :disabled="guardando">Guardar</button>
        <BotonDosToques
          v-if="editando" ref="botonEliminar" clase="boton-eliminar"
          texto-confirmar="Toca de nuevo para eliminar" @confirmado="eliminar"
        >Eliminar sensor</BotonDosToques>
      </div>
    </form>
  </Hoja>
</template>
