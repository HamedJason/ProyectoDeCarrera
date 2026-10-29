/*
 * Errores internos. El texto de un fallo de PostgreSQL o de Node puede revelar
 * nombres de tablas, columnas o rutas, asi que no se devuelve al cliente salvo
 * en la etapa de pruebas (MODO_PRUEBAS=true). Siempre queda en el registro del
 * servidor para poder diagnosticarlo.
 */
const MODO_PRUEBAS = String(process.env.MODO_PRUEBAS || '').toLowerCase() === 'true';

function detalleError(e) {
  console.error('Error interno:', e && e.message ? e.message : e);
  return MODO_PRUEBAS && e ? e.message : undefined;   // JSON.stringify omite undefined
}

module.exports = { detalleError };
