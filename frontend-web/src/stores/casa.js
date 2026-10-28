/*
 * Estado de la vivienda que se esta viendo: armado, alarma, sensores, nodos e
 * historial. Se actualiza consultando al servidor cada pocos segundos.
 */
import { ref } from 'vue';
import { pedir, ErrorSesion, mensajeDeError } from '../api/cliente.js';
import { construirHitos } from '../utils/hitos.js';
import { horaActual } from '../utils/formato.js';
import { vivienda } from './sesion.js';
import { conexion, mostrarAviso, ocultarAviso } from './conexion.js';
import { alertar, restaurarTitulo } from './avisos.js';
import { refrescarCamara, reiniciarCamara } from './camara.js';

export const INTERVALO_MS = 2500;
export const MOVIMIENTO_RECIENTE_S = 12;   // cuanto tiempo se considera "ahora" una deteccion

const estadoInicial = () => ({ armado: false, modo_silencioso: false, actuador_activo: false, alarma_activa: false });

export const estado = ref(estadoInicial());
export const estadoCargado = ref(false);   // ya respondio el servidor con el estado de la casa
export const sensores = ref([]);
export const nodos = ref([]);
export const hitos = ref([]);
export const cargado = ref(false);         // ya hubo una consulta completa (distingue "cargando" de "sin sensores")
export const ocupado = ref(false);

// cuenta.js lo conecta: cuando el servidor niega el acceso a la vivienda hay que recargar la lista
export const ganchos = { alPerderAcceso: async () => {} };

let temporizador = null;
let fallosSeguidos = 0;
let primeraCarga = true;   // evita alertar por una alarma que ya estaba activa al abrir la app

// Limpia lo que pertenecia a la vivienda anterior para no mezclar datos
export function reiniciarVistas() {
  estado.value = estadoInicial();
  estadoCargado.value = false;
  sensores.value = []; nodos.value = []; hitos.value = []; cargado.value = false;
  reiniciarCamara();
  primeraCarga = true;
  fallosSeguidos = 0;
  restaurarTitulo();
}

export async function refrescar(manual = false) {
  if (!vivienda.value) return;
  const casa = vivienda.value;
  try {
    const q = encodeURIComponent(casa);
    const [est, med, acc, sen] = await Promise.all([
      pedir('/estado?vivienda_id=' + q),
      pedir('/mediciones?vivienda_id=' + q + '&limite=40'),
      pedir('/acciones?vivienda_id=' + q + '&limite=40'),
      pedir('/sensores?vivienda_id=' + q)
    ]);

    if (casa !== vivienda.value) return;   // se cambio de vivienda mientras se esperaba
    if (est) {
      const antes = estado.value.alarma_activa;
      estado.value = est;
      estadoCargado.value = true;
      if (!est.alarma_activa) restaurarTitulo();
      // Se avisa solo en el momento en que la alarma pasa de apagada a activa
      if (est.alarma_activa && !antes && primeraCarga === false) alertar(est.alarma_motivo);
      primeraCarga = false;
    }

    const mediciones = med && med.mediciones ? med.mediciones : [];
    const acciones = acc && acc.acciones ? acc.acciones : [];
    sensores.value = sen && sen.sensores ? sen.sensores : [];
    nodos.value = sen && sen.nodos ? sen.nodos : [];
    hitos.value = construirHitos(mediciones, acciones, sensores.value);
    cargado.value = true;

    fallosSeguidos = 0;
    ocultarAviso();
    conexion.pie = 'Actualizado ' + horaActual();
  } catch (e) {
    if (e instanceof ErrorSesion) return;
    if (e.status === 403) { await ganchos.alPerderAcceso(); return; }
    fallosSeguidos++;
    // Se avisa al segundo fallo, para no alarmar por un parpadeo de la red
    if (manual || fallosSeguidos >= 2) mostrarAviso(mensajeDeError(e));
  }
}

export async function cambiarEstado(cambios) {
  if (ocupado.value) return;
  ocupado.value = true;
  try {
    const r = await pedir('/estado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vivienda_id: vivienda.value, ...cambios })
    });
    if (r) {
      estado.value = { ...estado.value, ...r };
      if (!estado.value.alarma_activa) restaurarTitulo();
      ocultarAviso();
      refrescar();
    }
  } catch (e) {
    if (!(e instanceof ErrorSesion)) mostrarAviso(mensajeDeError(e));
  } finally {
    ocupado.value = false;
  }
}

export const alternarArmado   = () => cambiarEstado({ armado: !estado.value.armado });
export const alternarSilencio = () => cambiarEstado({ modo_silencioso: !estado.value.modo_silencioso });
export const alternarSirena   = () => cambiarEstado({ actuador_activo: !estado.value.actuador_activo });
export const apagarAlarma     = () => cambiarEstado({ alarma_activa: false });

export function iniciarRefresco() {
  if (temporizador) return;
  let ciclos = 0;
  temporizador = setInterval(() => {
    refrescar();
    if (++ciclos % 4 === 0) refrescarCamara();
  }, INTERVALO_MS);
}

export function detenerRefresco() {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
}
