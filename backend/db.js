/*
 * Conexion a PostgreSQL.
 *
 * Se usa una sola cadena de conexion (DATABASE_URL) porque es el formato que
 * entregan directamente Neon, Supabase y Render, lo que evita manejar host,
 * puerto, usuario y contrasena por separado en las variables de entorno.
 */

// Carga el archivo .env solo en desarrollo local. En Render las variables de
// entorno las inyecta el propio servicio, por lo que esta llamada no hace nada
// alli y no estorba.
require('dotenv').config();

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.warn('Advertencia: DATABASE_URL no esta definida. Revisa el archivo .env');
}

/*
 * TLS condicional.
 *
 * Los proveedores en la nube (Neon, Supabase, Render) exigen conexion cifrada,
 * pero usan certificados que el cliente no puede verificar por cadena, por lo
 * que se acepta la conexion cifrada sin verificacion estricta del certificado.
 * Un PostgreSQL local de desarrollo normalmente no tiene TLS habilitado, asi que
 * activarlo siempre impediria probar el backend en la computadora propia.
 */
const urlBd = process.env.DATABASE_URL || '';
const esLocal = urlBd.includes('localhost') || urlBd.includes('127.0.0.1') || urlBd.includes('@/');
const usarSsl = !esLocal && process.env.PGSSL !== 'off';

const pool = new Pool({
  connectionString: urlBd,
  ssl: usarSsl ? { rejectUnauthorized: false } : false
});

/*
 * Crea la tabla si no existe.
 * Se ejecuta al arrancar para que el despliegue quede funcional sin pasos
 * manuales, lo cual simplifica volver a levantar el servicio durante pruebas.
 */
async function inicializarEsquema() {
  const rutaSql = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(rutaSql, 'utf8');
  await pool.query(sql);
  console.log('Esquema de base de datos verificado.');
}

module.exports = { pool, inicializarEsquema };
