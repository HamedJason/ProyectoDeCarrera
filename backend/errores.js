// El texto de un error de PostgreSQL o Node puede revelar tablas, columnas o rutas: solo se
// devuelve con MODO_PRUEBAS=true. Siempre queda en el registro del servidor.
const MODO_PRUEBAS = String(process.env.MODO_PRUEBAS || '').toLowerCase() === 'true';

function detalleError(e) {
  console.error('Error interno:', e && e.message ? e.message : e);
  return MODO_PRUEBAS && e ? e.message : undefined;   // JSON.stringify omite undefined
}

module.exports = { detalleError };
