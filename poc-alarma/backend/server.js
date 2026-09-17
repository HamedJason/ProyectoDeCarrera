/*
 * Proyecto de Carrera - Sistema escalable de seguridad residencial
 * Taller 5: Prueba de concepto reducida
 *
 * Backend minimo desplegado en la nube.
 *
 * Responsabilidades demostradas en esta etapa:
 *   - Recibir un tipo de dato proveniente del sistema embebido
 *   - Validar los campos indispensables y responder de forma comprensible
 *   - Registrar la informacion en PostgreSQL
 *   - Permitir que el frontend consulte la informacion
 *   - Mantener el estado del actuador para el control remoto basico
 */

const express = require('express');
const cors = require('cors');
const { pool, inicializarEsquema } = require('./db');

const app = express();
const PUERTO = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'poc-token-demo';

app.use(cors());
app.use(express.json());

// Registro simple de peticiones, util durante las pruebas del taller
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// ===================== Validacion =====================

/*
 * Valida el cuerpo de una medicion.
 * Devuelve un arreglo de errores. Si esta vacio, el dato es aceptable.
 *
 * Se validan por separado los campos ausentes y los campos con tipo incorrecto,
 * porque durante las pruebas conviene distinguir un dato incompleto de un dato
 * mal formado. Esa distincion tambien hace comprensible la respuesta de error.
 */
function validarMedicion(cuerpo) {
  const errores = [];

  if (!cuerpo || typeof cuerpo !== 'object') {
    return ['El cuerpo de la peticion debe ser un objeto JSON.'];
  }

  const obligatorios = ['vivienda_id', 'nodo_id', 'sensor_id', 'variable', 'valor'];
  for (const campo of obligatorios) {
    if (cuerpo[campo] === undefined || cuerpo[campo] === null || cuerpo[campo] === '') {
      errores.push(`Falta el campo obligatorio "${campo}".`);
    }
  }

  if (cuerpo.valor !== undefined && cuerpo.valor !== null && cuerpo.valor !== '') {
    const valorNumerico = Number(cuerpo.valor);
    if (Number.isNaN(valorNumerico)) {
      errores.push('El campo "valor" debe ser numerico.');
    }
  }

  if (cuerpo.numero_registro !== undefined && cuerpo.numero_registro !== null) {
    if (Number.isNaN(Number(cuerpo.numero_registro))) {
      errores.push('El campo "numero_registro" debe ser numerico cuando se envia.');
    }
  }

  return errores;
}

// ===================== Endpoints =====================

// Verificacion de que el servicio esta vivo. Sirve como evidencia del despliegue.
app.get('/salud', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS hora');
    res.json({
      estado: 'ok',
      servicio: 'backend-poc-alarma',
      base_de_datos: 'conectada',
      hora_servidor: r.rows[0].hora
    });
  } catch (e) {
    res.status(500).json({ estado: 'error', base_de_datos: 'sin conexion', detalle: e.message });
  }
});

/*
 * POST /mediciones
 * Registra una medicion enviada por el sistema embebido.
 * La marca de tiempo la asigna el backend, tal como permite la actividad,
 * porque el ESP32 no cuenta con reloj de tiempo real en esta etapa.
 */
app.post('/mediciones', async (req, res) => {
  const token = req.header('X-Device-Token');
  if (token !== DEVICE_TOKEN) {
    return res.status(401).json({
      ok: false,
      mensaje: 'Token de dispositivo invalido o ausente.'
    });
  }

  const errores = validarMedicion(req.body);
  if (errores.length > 0) {
    return res.status(400).json({
      ok: false,
      mensaje: 'La medicion no pudo registrarse porque el dato es incorrecto.',
      errores
    });
  }

  const {
    vivienda_id, zona = null, nodo_id, sensor_id,
    variable, valor, unidad = null, numero_registro = null
  } = req.body;

  try {
    const consulta = `
      INSERT INTO mediciones
        (vivienda_id, zona, nodo_id, sensor_id, variable, valor, unidad, numero_registro)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, vivienda_id, zona, nodo_id, sensor_id, variable, valor, unidad,
                numero_registro, creado_en
    `;
    const r = await pool.query(consulta, [
      vivienda_id, zona, nodo_id, sensor_id,
      variable, Number(valor), unidad,
      numero_registro === null ? null : Number(numero_registro)
    ]);

    return res.status(201).json({
      ok: true,
      mensaje: 'Medicion registrada correctamente.',
      medicion: r.rows[0]
    });
  } catch (e) {
    console.error('Error al insertar medicion:', e.message);
    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudo registrar la medicion en la base de datos.',
      detalle: e.message
    });
  }
});

/*
 * GET /mediciones
 * Devuelve el historico para el frontend, de la mas reciente a la mas antigua.
 */
app.get('/mediciones', async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 50, 200);
  const viviendaId = req.query.vivienda_id;

  try {
    let consulta = `
      SELECT id, vivienda_id, zona, nodo_id, sensor_id, variable, valor, unidad,
             numero_registro, creado_en
      FROM mediciones
    `;
    const params = [];

    if (viviendaId) {
      params.push(viviendaId);
      consulta += ` WHERE vivienda_id = $${params.length}`;
    }

    params.push(limite);
    consulta += ` ORDER BY creado_en DESC LIMIT $${params.length}`;

    const r = await pool.query(consulta, params);
    return res.json({ ok: true, total: r.rowCount, mediciones: r.rows });
  } catch (e) {
    console.error('Error al consultar mediciones:', e.message);
    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudieron consultar las mediciones.',
      detalle: e.message
    });
  }
});

/*
 * GET /mediciones/ultima
 * Devuelve unicamente el dato mas reciente, para la tarjeta principal del frontend.
 */
app.get('/mediciones/ultima', async (req, res) => {
  const viviendaId = req.query.vivienda_id;
  try {
    let consulta = `
      SELECT id, vivienda_id, zona, nodo_id, sensor_id, variable, valor, unidad,
             numero_registro, creado_en
      FROM mediciones
    `;
    const params = [];
    if (viviendaId) {
      params.push(viviendaId);
      consulta += ` WHERE vivienda_id = $${params.length}`;
    }
    consulta += ' ORDER BY creado_en DESC LIMIT 1';

    const r = await pool.query(consulta, params);
    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, mensaje: 'Todavia no hay mediciones registradas.' });
    }
    return res.json({ ok: true, medicion: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'Error al consultar.', detalle: e.message });
  }
});

// ===================== Control del actuador =====================

/*
 * Estado del actuador en memoria.
 * Para la prueba de concepto no se persiste, porque lo que se demuestra es el
 * camino frontend -> backend -> dispositivo, no la durabilidad del comando.
 * En el prototipo alfa este estado se mueve a la base de datos.
 */
const estadoActuador = {};   // { [vivienda_id]: boolean }

// El ESP32 consulta este endpoint periodicamente
app.get('/comando', (req, res) => {
  const viviendaId = req.query.vivienda_id || 'casa-001';
  res.json({
    ok: true,
    vivienda_id: viviendaId,
    actuador_activo: Boolean(estadoActuador[viviendaId])
  });
});

// El frontend escribe en este endpoint
app.post('/comando', (req, res) => {
  const { vivienda_id, actuador_activo } = req.body || {};

  if (!vivienda_id) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el campo obligatorio "vivienda_id".' });
  }
  if (typeof actuador_activo !== 'boolean') {
    return res.status(400).json({ ok: false, mensaje: 'El campo "actuador_activo" debe ser true o false.' });
  }

  estadoActuador[vivienda_id] = actuador_activo;
  console.log(`Comando recibido: ${vivienda_id} -> actuador ${actuador_activo ? 'ENCENDIDO' : 'APAGADO'}`);

  return res.json({
    ok: true,
    mensaje: `Comando aplicado. El nodo lo tomara en su siguiente consulta.`,
    vivienda_id,
    actuador_activo
  });
});

// ===================== Arranque =====================

app.use((req, res) => {
  res.status(404).json({ ok: false, mensaje: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

inicializarEsquema()
  .then(() => {
    app.listen(PUERTO, () => {
      console.log(`Backend escuchando en el puerto ${PUERTO}`);
    });
  })
  .catch((e) => {
    console.error('No se pudo inicializar el esquema de la base de datos:', e.message);
    process.exit(1);
  });
