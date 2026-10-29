// Conexion a PostgreSQL con una sola cadena (DATABASE_URL).

// Carga .env solo en desarrollo local; en un servidor las variables ya vienen inyectadas.
require('dotenv').config();

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.warn('Advertencia: DATABASE_URL no esta definida. Revisa el archivo .env');
}

// TLS condicional: los proveedores en la nube exigen conexion cifrada con certificados que no se verifican
// por cadena; un PostgreSQL local normalmente no tiene TLS, y forzarlo impediria probar en la computadora propia.
const urlBd = process.env.DATABASE_URL || '';
const esLocal = urlBd.includes('localhost') || urlBd.includes('127.0.0.1') || urlBd.includes('@/');
const usarSsl = !esLocal && process.env.PGSSL !== 'off';

const pool = new Pool({
  connectionString: urlBd,
  ssl: usarSsl ? { rejectUnauthorized: false } : false
});

// Crea las tablas al arrancar para que el despliegue quede funcional sin pasos manuales.
async function inicializarEsquema() {
  const rutaSql = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(rutaSql, 'utf8');
  await pool.query(sql);
  console.log('Esquema de base de datos verificado.');
}

module.exports = { pool, inicializarEsquema };
