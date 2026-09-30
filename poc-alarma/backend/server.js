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
const path = require('path');
const { pool, inicializarEsquema } = require('./db');

const app = express();
const PUERTO = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'poc-token-demo';

// Notificaciones push a traves de ntfy. Si NTFY_TOPIC esta vacio, el servicio
// funciona igual pero no envia avisos. Quien conozca el nombre del tema puede
// leer los avisos, por eso debe ser largo y dificil de adivinar.
const NTFY_URL = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

// Habilita funciones que solo tienen sentido durante las pruebas, como borrar
// el historial. Debe estar apagado cuando el sistema quede en uso real.
const MODO_PRUEBAS = String(process.env.MODO_PRUEBAS || '').toLowerCase() === 'true';

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

// ===================== Estado de la vivienda =====================

/*
 * Devuelve el estado de una vivienda, creandolo con valores por omision la
 * primera vez que se consulta. De esta forma una vivienda nueva no requiere
 * ningun alta previa, lo que sostiene el requisito de escalabilidad por
 * configuracion: basta con que un nodo empiece a reportar con su identificador.
 */
const COLUMNAS_ESTADO =
  'vivienda_id, armado, modo_silencioso, actuador_activo, alarma_activa, alarma_motivo, actualizado_en';

async function obtenerEstado(viviendaId) {
  const r = await pool.query(
    `INSERT INTO estado_vivienda (vivienda_id)
     VALUES ($1)
     ON CONFLICT (vivienda_id) DO UPDATE SET vivienda_id = EXCLUDED.vivienda_id
     RETURNING ${COLUMNAS_ESTADO}`,
    [viviendaId]
  );
  return r.rows[0];
}

/*
 * Traduce lo que reporta el nodo a un texto comprensible para el residente.
 */
function describirMotivo(variable, zona) {
  const lugar = zona ? ` en ${zona}` : '';
  if (variable === 'estado_puerta') return `Puerta abierta${lugar}`;
  if (variable === 'movimiento') return `Movimiento detectado${lugar}`;
  return `Actividad detectada${lugar}`;
}

/*
 * Envia una notificacion push mediante ntfy.
 * No se espera su resultado dentro de la peticion: si el servicio de avisos
 * falla o tarda, la alarma no debe retrasarse ni fallar por eso.
 * Se publica como JSON para que los acentos lleguen bien al telefono.
 */
function notificar(titulo, mensaje, prioridad = 5, etiquetas = ['rotating_light']) {
  if (!NTFY_TOPIC) return;
  fetch(NTFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: NTFY_TOPIC, title: titulo, message: mensaje, priority: prioridad, tags: etiquetas }),
    signal: AbortSignal.timeout(5000)
  })
    .then((r) => {
      if (!r.ok) console.error(`Notificacion rechazada por ntfy (codigo ${r.status}).`);
      else console.log('Notificacion enviada.');
    })
    .catch((e) => console.error('No se pudo enviar la notificacion:', e.message));
}

/*
 * Registra una accion del usuario sobre el sistema.
 * Responde al requisito de trazabilidad: permite saber quien cambio que y cuando.
 */
async function registrarAccion(viviendaId, accion, anterior, nuevo, usuario) {
  await pool.query(
    `INSERT INTO acciones (vivienda_id, accion, valor_anterior, valor_nuevo, usuario)
     VALUES ($1, $2, $3, $4, $5)`,
    [viviendaId, accion, String(anterior), String(nuevo), usuario || 'residente']
  );
}

/*
 * GET /estado
 * Lo consultan tanto el concentrador como la aplicacion.
 * El concentrador lo usa para decidir si un evento debe disparar la sirena.
 */
app.get('/estado', async (req, res) => {
  const viviendaId = req.query.vivienda_id || 'casa-001';
  try {
    const estado = await obtenerEstado(viviendaId);
    return res.json({ ok: true, ...estado });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'No se pudo consultar el estado.', detalle: e.message });
  }
});

/*
 * POST /estado
 * La aplicacion cambia el armado, el modo silencioso o la salida audible, y
 * puede apagar una alarma que este sonando.
 * Se aceptan cambios parciales: lo que no venga en la peticion no se modifica.
 */
app.post('/estado', async (req, res) => {
  const { vivienda_id, armado, modo_silencioso, actuador_activo, alarma_activa, usuario } = req.body || {};

  if (!vivienda_id) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el campo obligatorio "vivienda_id".' });
  }

  const campos = { armado, modo_silencioso, actuador_activo, alarma_activa };
  const errores = [];
  for (const [nombre, valor] of Object.entries(campos)) {
    if (valor !== undefined && typeof valor !== 'boolean') {
      errores.push(`El campo "${nombre}" debe ser true o false.`);
    }
  }
  // Una alarma solo la dispara un sensor. Desde la aplicacion unicamente se apaga.
  if (alarma_activa === true) {
    errores.push('La alarma solo puede activarla un sensor. Desde la aplicacion unicamente puede apagarse (alarma_activa: false).');
  }
  if (Object.values(campos).every(v => v === undefined)) {
    errores.push('Debe indicarse al menos uno de los campos "armado", "modo_silencioso", "actuador_activo" o "alarma_activa".');
  }
  if (errores.length > 0) {
    return res.status(400).json({ ok: false, mensaje: 'La solicitud es incorrecta.', errores });
  }

  try {
    const previo = await obtenerEstado(vivienda_id);

    const nuevoArmado = armado !== undefined ? armado : previo.armado;
    const nuevoSilencio = modo_silencioso !== undefined ? modo_silencioso : previo.modo_silencioso;
    const nuevoActuador = actuador_activo !== undefined ? actuador_activo : previo.actuador_activo;
    // Desarmar el sistema tambien apaga la alarma que estuviera sonando
    const nuevaAlarma = (alarma_activa === false || nuevoArmado === false) ? false : previo.alarma_activa;

    const r = await pool.query(
      `UPDATE estado_vivienda
          SET armado = $2, modo_silencioso = $3, actuador_activo = $4,
              alarma_activa = $5,
              alarma_motivo = CASE WHEN $5 THEN alarma_motivo ELSE NULL END,
              actualizado_en = NOW()
        WHERE vivienda_id = $1
        RETURNING ${COLUMNAS_ESTADO}`,
      [vivienda_id, nuevoArmado, nuevoSilencio, nuevoActuador, nuevaAlarma]
    );

    // Solo se registran los cambios reales, no las confirmaciones del mismo valor
    if (armado !== undefined && armado !== previo.armado) {
      await registrarAccion(vivienda_id, armado ? 'armar' : 'desarmar', previo.armado, armado, usuario);
    }
    if (modo_silencioso !== undefined && modo_silencioso !== previo.modo_silencioso) {
      await registrarAccion(vivienda_id, 'modo_silencioso', previo.modo_silencioso, modo_silencioso, usuario);
    }
    if (actuador_activo !== undefined && actuador_activo !== previo.actuador_activo) {
      await registrarAccion(vivienda_id, 'salida_audible', previo.actuador_activo, actuador_activo, usuario);
    }
    if (alarma_activa === false && previo.alarma_activa) {
      await registrarAccion(vivienda_id, 'apagar_alarma', true, false, usuario);
    }

    console.log(`Estado actualizado: ${vivienda_id} -> armado=${nuevoArmado} silencioso=${nuevoSilencio} salida=${nuevoActuador} alarma=${nuevaAlarma}`);
    return res.json({ ok: true, mensaje: 'Estado actualizado.', ...r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'No se pudo actualizar el estado.', detalle: e.message });
  }
});

/*
 * POST /alarma
 * Lo usa el nodo para avisar que una alarma empezo o termino de sonar.
 * Requiere el token del dispositivo, a diferencia de /estado, porque solo un
 * sensor debe poder declarar una alarma.
 *
 * Campos: vivienda_id, activa, y opcionalmente nodo_id, motivo (variable que
 * disparo, por ejemplo "estado_puerta"), zona y silenciosa.
 *
 * Con silenciosa = true el nodo dispara sin sirena por el modo silencioso: se
 * registra y se notifica, pero no se marca alarma activa porque no hay nada
 * que apagar.
 *
 * Si el nodo avisa una alarma pero el sistema ya no esta armado (por ejemplo
 * el usuario lo desarmo justo en ese instante), no se marca la alarma. La
 * respuesta sigue siendo correcta para que el nodo no reintente sin fin.
 */
app.post('/alarma', async (req, res) => {
  if (req.header('X-Device-Token') !== DEVICE_TOKEN) {
    return res.status(401).json({ ok: false, mensaje: 'Token de dispositivo invalido o ausente.' });
  }

  const { vivienda_id, activa, nodo_id, motivo, zona, silenciosa } = req.body || {};
  if (!vivienda_id) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el campo obligatorio "vivienda_id".' });
  }
  if (typeof activa !== 'boolean') {
    return res.status(400).json({ ok: false, mensaje: 'El campo "activa" debe ser true o false.' });
  }

  try {
    const previo = await obtenerEstado(vivienda_id);
    const texto = describirMotivo(motivo, zona);

    if (activa && !previo.armado) {
      return res.json({ ok: true, aplicada: false, mensaje: 'El sistema no esta armado. No se marco la alarma.', ...previo });
    }

    if (activa && silenciosa === true) {
      await registrarAccion(vivienda_id, 'alarma_silenciosa', false, true, nodo_id || 'dispositivo');
      notificar('Alarma en modo silencioso', `${texto}. Vivienda ${vivienda_id}. La sirena no sono.`, 4, ['warning']);
      return res.json({ ok: true, aplicada: false, mensaje: 'Alarma silenciosa registrada y notificada.', ...previo });
    }

    const r = await pool.query(
      `UPDATE estado_vivienda
          SET alarma_activa = $2,
              alarma_motivo = CASE WHEN $2 THEN $3::text ELSE NULL END,
              actualizado_en = NOW()
        WHERE vivienda_id = $1
        RETURNING ${COLUMNAS_ESTADO}`,
      [vivienda_id, activa, texto]
    );

    if (activa !== previo.alarma_activa) {
      await registrarAccion(vivienda_id, activa ? 'alarma_activada' : 'alarma_terminada',
                            previo.alarma_activa, activa, nodo_id || 'dispositivo');
      if (activa) {
        notificar('ALARMA ACTIVADA', `${texto}. Vivienda ${vivienda_id}.`, 5, ['rotating_light']);
      }
    }
    return res.json({ ok: true, aplicada: true, ...r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'No se pudo actualizar la alarma.', detalle: e.message });
  }
});

/*
 * POST /limpiar
 * Borra el historial de una vivienda. Existe solo para la etapa de pruebas, y
 * responde 403 salvo que el servidor tenga MODO_PRUEBAS=true. No borra el
 * estado de armado ni la configuracion, unicamente los registros.
 *
 * Campo "que": "mediciones", "acciones" o "todo" (por omision).
 */
app.post('/limpiar', async (req, res) => {
  if (!MODO_PRUEBAS) {
    return res.status(403).json({
      ok: false,
      mensaje: 'La limpieza del historial esta deshabilitada. Solo se permite con MODO_PRUEBAS=true en el servidor.'
    });
  }

  const { vivienda_id, que = 'todo' } = req.body || {};
  if (!vivienda_id) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el campo obligatorio "vivienda_id".' });
  }
  if (!['mediciones', 'acciones', 'todo'].includes(que)) {
    return res.status(400).json({ ok: false, mensaje: 'El campo "que" debe ser "mediciones", "acciones" o "todo".' });
  }

  try {
    const borrado = { mediciones: 0, acciones: 0 };
    if (que === 'mediciones' || que === 'todo') {
      borrado.mediciones = (await pool.query('DELETE FROM mediciones WHERE vivienda_id = $1', [vivienda_id])).rowCount;
    }
    if (que === 'acciones' || que === 'todo') {
      borrado.acciones = (await pool.query('DELETE FROM acciones WHERE vivienda_id = $1', [vivienda_id])).rowCount;
    }
    console.log(`Historial limpiado: ${vivienda_id} -> ${JSON.stringify(borrado)}`);
    return res.json({ ok: true, mensaje: 'Historial borrado.', borrado });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'No se pudo borrar el historial.', detalle: e.message });
  }
});

/*
 * GET /configuracion
 * Informa a la aplicacion que funciones estan habilitadas en este servidor,
 * para mostrar u ocultar controles como el de limpiar el historial.
 */
app.get('/configuracion', (_req, res) => {
  res.json({ ok: true, modo_pruebas: MODO_PRUEBAS, notificaciones_push: Boolean(NTFY_TOPIC) });
});

/*
 * GET /acciones
 * Bitacora de acciones del usuario, para la pantalla de historial.
 */
app.get('/acciones', async (req, res) => {
  const viviendaId = req.query.vivienda_id || 'casa-001';
  const limite = Math.min(Number(req.query.limite) || 30, 200);
  try {
    const r = await pool.query(
      `SELECT id, vivienda_id, accion, valor_anterior, valor_nuevo, usuario, creado_en
         FROM acciones
        WHERE vivienda_id = $1
        ORDER BY creado_en DESC
        LIMIT $2`,
      [viviendaId, limite]
    );
    return res.json({ ok: true, total: r.rowCount, acciones: r.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'No se pudieron consultar las acciones.', detalle: e.message });
  }
});

// ===================== Compatibilidad =====================

/*
 * Los endpoints /comando se conservan porque el firmware de la prueba de
 * concepto los utiliza. Ahora leen y escriben sobre la misma tabla de estado,
 * de modo que no existan dos fuentes de verdad.
 */
app.get('/comando', async (req, res) => {
  const viviendaId = req.query.vivienda_id || 'casa-001';
  try {
    const estado = await obtenerEstado(viviendaId);
    return res.json({
      ok: true,
      vivienda_id: estado.vivienda_id,
      actuador_activo: estado.actuador_activo
    });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'Error al consultar.', detalle: e.message });
  }
});

app.post('/comando', async (req, res) => {
  const { vivienda_id, actuador_activo } = req.body || {};
  if (!vivienda_id) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el campo obligatorio "vivienda_id".' });
  }
  if (typeof actuador_activo !== 'boolean') {
    return res.status(400).json({ ok: false, mensaje: 'El campo "actuador_activo" debe ser true o false.' });
  }
  try {
    const previo = await obtenerEstado(vivienda_id);
    await pool.query(
      `UPDATE estado_vivienda SET actuador_activo = $2, actualizado_en = NOW() WHERE vivienda_id = $1`,
      [vivienda_id, actuador_activo]
    );
    if (actuador_activo !== previo.actuador_activo) {
      await registrarAccion(vivienda_id, 'salida_audible', previo.actuador_activo, actuador_activo, 'residente');
    }
    return res.json({
      ok: true,
      mensaje: 'Comando aplicado. El nodo lo tomara en su siguiente consulta.',
      vivienda_id,
      actuador_activo
    });
  } catch (e) {
    return res.status(500).json({ ok: false, mensaje: 'Error al aplicar el comando.', detalle: e.message });
  }
});

// ===================== Frontend =====================

/*
 * La aplicacion se sirve desde el mismo servicio que la API.
 * Esto evita configurar un despliegue aparte y hace que el origen sea el mismo,
 * por lo que el navegador no necesita permisos adicionales entre ambos.
 */
app.use(express.static(path.join(__dirname, 'publico')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'publico', 'index.html'));
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
