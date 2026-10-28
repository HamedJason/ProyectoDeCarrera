/*
 * Cliente HTTP de la aplicacion. La pagina se sirve desde el mismo backend,
 * asi que todas las rutas son relativas al mismo origen.
 */
export const TIEMPO_LIMITE_MS = 8000;

// Se lanza cuando el servidor responde 401: ya se mostro la pantalla de acceso
export class ErrorSesion extends Error {}

// La pila de sesion se registra desde afuera para no depender de ella aqui
let alCaducar = () => {};
export function registrarCaducidad(fn) { alCaducar = fn; }

// fetch con tiempo limite, para distinguir una red caida de una espera larga
export async function pedir(ruta, opciones = {}) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);
  try {
    const r = await fetch(ruta, { ...opciones, signal: control.signal });
    if (r.status === 401) { alCaducar(); throw new ErrorSesion('Sesión caducada'); }
    if (!r.ok && r.status !== 404) {
      const e = new Error('El servidor respondió con código ' + r.status);
      e.status = r.status;
      throw e;
    }
    return r.status === 404 ? null : await r.json();
  } finally {
    clearTimeout(reloj);
  }
}

// POST con cuerpo JSON que devuelve el JSON del servidor (lanza si falla)
export function pedirJson(ruta, cuerpo) {
  return pedir(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
}

// Como pedir, pero no lanza por los codigos 4xx: devuelve { ok, status, datos } para mostrar el mensaje del servidor
export async function enviarJson(ruta, metodo, cuerpo) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);
  try {
    const r = await fetch(ruta, {
      method: metodo, signal: control.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo || {})
    });
    if (r.status === 401 && !String(ruta).startsWith('/auth/')) { alCaducar(); throw new ErrorSesion('Sesión caducada'); }
    let datos = {};
    try { datos = await r.json(); } catch (e) { /* respuesta sin cuerpo */ }
    return { ok: r.ok, status: r.status, datos };
  } finally {
    clearTimeout(reloj);
  }
}

/*
 * Traduce el fallo a un mensaje que el usuario pueda accionar.
 * El navegador entrega textos internos en ingles como "Failed to fetch",
 * que no dicen nada a quien usa la aplicacion.
 */
export function mensajeDeError(e) {
  if (e.name === 'AbortError') {
    return 'El servidor no respondió a tiempo. Revisa tu conexión a Internet.';
  }
  if (e instanceof TypeError) {
    return 'No hay comunicación con el servidor. Puede estar apagado o sin conexión a Internet.';
  }
  return 'No se pudo completar la operación. ' + e.message;
}
