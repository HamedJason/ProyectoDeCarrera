/*
 * Acciones de cuenta y viviendas: iniciar y cerrar sesion, elegir vivienda,
 * crear o unirse a una, administrarla. Cada una devuelve '' si salio bien o el
 * mensaje de error para mostrarlo en el formulario.
 */
import { pedir, enviarJson, registrarCaducidad, ErrorSesion, mensajeDeError } from '../api/cliente.js';
import { sesion, vivienda, pantalla, acceso } from './sesion.js';
import { ui, abrirCasas, abrirGestion, cerrarTodo } from './ui.js';
import {
  ganchos, refrescar, reiniciarVistas, iniciarRefresco, detenerRefresco
} from './casa.js';
import { refrescarCamara } from './camara.js';
import { cancelarPush, cargarConfiguracion, sincronizarPush, reanudarPush } from './avisos.js';

// ===================== Acceso y sesion =====================

function mostrarAcceso() {
  pantalla.value = 'acceso';
}

// Ajusta el formulario de registro segun la politica del servidor
export async function prepararAcceso(mensaje) {
  try {
    const a = await pedir('/auth/estado');
    const codigo = new URLSearchParams(location.search).get('codigo') || '';
    acceso.codigoInicial = codigo;
    if (a && !a.hay_usuarios) {
      acceso.subtitulo = 'Todavía no hay cuentas. Crea la primera: será la propietaria de las viviendas existentes.';
      acceso.ocultarCodigo = true;
      acceso.nota = '';
      acceso.pestana = 'crear';
      acceso.ocultarPestanas = true;
    } else {
      acceso.ocultarPestanas = false;
      acceso.ocultarCodigo = false;
      const cerrado = !!a && !a.registro_abierto;
      acceso.codigoEtiqueta = cerrado ? 'Código de invitación (obligatorio)' : 'Código de invitación (opcional)';
      acceso.codigoRequerido = cerrado;
      acceso.nota = cerrado ? 'El registro es solo por invitación. Pide un código a quien administre la vivienda.' : '';
      acceso.subtitulo = mensaje || 'Inicia sesión para ver tu casa.';
      acceso.pestana = codigo ? 'crear' : 'entrar';
    }
  } catch (e) { /* si no responde, se muestra el aviso en arrancar */ }
  mostrarAcceso();
}

export async function arrancar() {
  acceso.avisoError = '';
  try {
    const r = await fetch('/auth/yo', { cache: 'no-store' });
    if (r.status === 401) { sesion.value = null; await prepararAcceso(); return; }
    if (!r.ok) throw new Error('El servidor respondió con código ' + r.status);
    sesion.value = await r.json();
  } catch (e) {
    mostrarAcceso();
    acceso.avisoError = mensajeDeError(e);
    return;
  }
  entrarALaApp();
}

function sesionCaducada() {
  if (!sesion.value) return;
  sesion.value = null; vivienda.value = null;
  detenerRefresco();
  cerrarTodo();
  prepararAcceso('Tu sesión terminó. Inicia sesión de nuevo.');
}
registrarCaducidad(sesionCaducada);

export async function entrar(email, clave) {
  try {
    const r = await enviarJson('/auth/entrar', 'POST', { email, clave });
    if (!r.ok) return r.datos.mensaje || 'No se pudo iniciar sesión.';
    await arrancar();
    return '';
  } catch (e) {
    return mensajeDeError(e);
  }
}

export async function crearCuenta(datos) {
  try {
    const r = await enviarJson('/auth/registro', 'POST', datos);
    if (!r.ok) return r.datos.mensaje || 'No se pudo crear la cuenta.';
    history.replaceState(null, '', location.pathname);   // quita ?codigo= de la direccion
    await arrancar();
    return '';
  } catch (e) {
    return mensajeDeError(e);
  }
}

export async function cerrarSesion() {
  try { await cancelarPush(); } catch (e) { /* se continua */ }
  try { await enviarJson('/auth/salir', 'POST', {}); } catch (e) { /* la sesion se descarta aqui de todos modos */ }
  ui.casas = false;
  sesion.value = null; vivienda.value = null;
  detenerRefresco(); reiniciarVistas();
  await prepararAcceso();
}

export async function cambiarClave(actual, nueva) {
  try {
    const r = await enviarJson('/auth/clave', 'POST', { actual, nueva });
    if (!r.ok) return { ok: false, mensaje: r.datos.mensaje || 'No se pudo cambiar la contraseña.' };
    return { ok: true, mensaje: 'Contraseña actualizada.' };
  } catch (e) {
    if (e instanceof ErrorSesion) return { ok: true, mensaje: '' };
    return { ok: false, mensaje: mensajeDeError(e) };
  }
}

// ===================== Viviendas =====================

function entrarALaApp() {
  pantalla.value = 'app';

  const ids = sesion.value.viviendas.map((v) => v.id);
  let guardada = null;
  try { guardada = localStorage.getItem('vivienda'); } catch (e) { /* sin almacenamiento */ }
  const deUrl = new URLSearchParams(location.search).get('vivienda');
  const elegida = [deUrl, guardada].find((x) => x && ids.includes(x)) || ids[0] || null;

  if (!elegida) { sinViviendas(); return; }
  fijarVivienda(elegida);
  iniciarRefresco();
  cargarConfiguracion().then(sincronizarPush);
}

function sinViviendas() {
  vivienda.value = null;
  detenerRefresco();
  reiniciarVistas();
  abrirCasas();
}

export function fijarVivienda(id) {
  vivienda.value = id;
  try { localStorage.setItem('vivienda', id); } catch (e) { /* sin almacenamiento */ }
  reiniciarVistas();
  refrescar(true);
  refrescarCamara();
  iniciarRefresco();
}

export async function recargarViviendas() {
  try {
    const r = await pedir('/auth/yo');
    if (!r) return;
    sesion.value = r;
    const ids = sesion.value.viviendas.map((v) => v.id);
    if (!ids.length) { sinViviendas(); return; }
    if (!ids.includes(vivienda.value)) { fijarVivienda(ids[0]); return; }
  } catch (e) { /* se reintenta en el siguiente ciclo */ }
}
ganchos.alPerderAcceso = recargarViviendas;

export function elegirVivienda(id) {
  ui.casas = false;
  if (id !== vivienda.value) fijarVivienda(id);
}

export async function crearCasa(nombre) {
  if (!nombre) return 'Escribe un nombre para la vivienda.';
  try {
    const r = await enviarJson('/viviendas', 'POST', { nombre });
    if (!r.ok) return r.datos.mensaje || 'No se pudo crear la vivienda.';
    ui.tokenPendiente = r.datos.token;
    await recargarViviendas();
    ui.casas = false;
    fijarVivienda(r.datos.vivienda.id);
    reanudarPush();
    abrirGestion();
    return '';
  } catch (e) {
    return e instanceof ErrorSesion ? '' : mensajeDeError(e);
  }
}

export async function unirseConCodigo(codigo) {
  if (!codigo) return 'Escribe el código de invitación.';
  try {
    const r = await enviarJson('/invitaciones/aceptar', 'POST', { codigo });
    if (!r.ok) return r.datos.mensaje || 'No se pudo aceptar la invitación.';
    await recargarViviendas();
    ui.casas = false;
    fijarVivienda(r.datos.vivienda_id);
    reanudarPush();
    return '';
  } catch (e) {
    return e instanceof ErrorSesion ? '' : mensajeDeError(e);
  }
}

// ===================== Administracion de la vivienda =====================

const rutaCasa = () => '/viviendas/' + encodeURIComponent(vivienda.value);
const resultado = (r, falla) => (r.ok ? '' : (r.datos.mensaje || falla));

export async function cargarMiembros() {
  return pedir(rutaCasa() + '/miembros');
}

export async function quitarMiembro(uid, esYo) {
  try {
    const r = await enviarJson(rutaCasa() + '/miembros/' + uid, 'DELETE', {});
    if (!r.ok) return r.datos.mensaje || 'No se pudo completar.';
    if (esYo) { ui.gestion = false; await recargarViviendas(); }
    return '';
  } catch (e) { return e instanceof ErrorSesion ? '' : mensajeDeError(e); }
}

export async function renombrarCasa(nombre) {
  if (!nombre) return '';
  try {
    const r = await enviarJson(rutaCasa(), 'PATCH', { nombre });
    if (!r.ok) return r.datos.mensaje || 'No se pudo renombrar.';
    await recargarViviendas();
    return '';
  } catch (e) { return e instanceof ErrorSesion ? '' : mensajeDeError(e); }
}

export async function crearInvitacion() {
  try {
    const r = await enviarJson(rutaCasa() + '/invitaciones', 'POST', {});
    if (!r.ok) return { error: r.datos.mensaje || 'No se pudo crear el código.' };
    return { codigo: r.datos.codigo, horas: r.datos.horas };
  } catch (e) { return { error: e instanceof ErrorSesion ? '' : mensajeDeError(e) }; }
}

export async function generarToken() {
  try {
    const r = await enviarJson(rutaCasa() + '/token', 'POST', {});
    if (!r.ok) return { error: r.datos.mensaje || 'No se pudo generar el token.' };
    return { token: r.datos.token };
  } catch (e) { return { error: e instanceof ErrorSesion ? '' : mensajeDeError(e) }; }
}

export async function eliminarCasa(confirmar) {
  try {
    const r = await enviarJson(rutaCasa(), 'DELETE', { confirmar });
    if (!r.ok) return resultado(r, 'No se pudo eliminar.');
    ui.gestion = false;
    try { localStorage.removeItem('vivienda'); } catch (e) { /* sin almacenamiento */ }
    vivienda.value = null;
    await recargarViviendas();
    return '';
  } catch (e) { return e instanceof ErrorSesion ? '' : mensajeDeError(e); }
}
