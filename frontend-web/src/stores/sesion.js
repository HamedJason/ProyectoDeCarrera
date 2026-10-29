// Estado de la sesion: quien inicio sesion, que vivienda se ve y que pantalla corresponde. Solo guarda datos; las acciones estan en cuenta.js.
import { ref, reactive, computed } from 'vue';

export const sesion = ref(null);       // { usuario, viviendas } cuando hay sesion iniciada
export const vivienda = ref(null);     // id de la vivienda que se esta viendo
export const pantalla = ref('cargando'); // 'cargando' | 'acceso' | 'app'

export const casaActual = computed(() =>
  (sesion.value && sesion.value.viviendas.find((v) => v.id === vivienda.value)) || null);
export const nombreCasa = computed(() => (casaActual.value ? casaActual.value.nombre : 'Vivienda'));
export const esPropietario = computed(() => !!casaActual.value && casaActual.value.rol === 'propietario');

// Lo que muestra la pantalla de acceso segun la politica de registro del servidor
export const acceso = reactive({
  subtitulo: 'Inicia sesión para ver tu casa.',
  pestana: 'entrar',
  ocultarPestanas: false,
  ocultarCodigo: false,
  codigoEtiqueta: 'Código de invitación',
  codigoRequerido: false,
  nota: '',
  codigoInicial: '',
  avisoError: ''      // no hay comunicacion con el servidor
});
