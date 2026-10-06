/*
 * Camara de la vivienda (ESP32 con sensor OV5640).
 *
 * Como funciona, y por que asi:
 *
 *   La camara y el servidor nunca se comunican en sentido servidor -> camara,
 *   porque la camara esta detras del router de la casa. Es la camara la que
 *   pregunta. Para que no tarde en enterarse, pregunta con una peticion larga
 *   (GET /camara/tarea?espera=20): el servidor la deja abierta hasta 20 s y la
 *   contesta en el instante en que aparece una tarea. Cuando no hay nada que
 *   hacer cuesta una peticion cada 20 s, y cuando suena la alarma la camara
 *   se entera en milisegundos, sin necesidad de ESP-NOW.
 *
 *   Tareas:
 *     foto  una rafaga de fotos (por una alarma, o a peticion del usuario)
 *     vivo  una sesion de vista en vivo, con tiempo maximo y cuota diaria
 *
 *   Las fotos se guardan como archivos en disco con un tope de dias y de
 *   espacio por vivienda y total, porque el disco del VPS es el recurso mas
 *   escaso: no se guarda video, solo imagenes fijas. En la vista en vivo el
 *   servidor solo retransmite el ultimo cuadro que recibe, sin guardarlo.
 *
 *   Las fotos y los cuadros llegan como cuerpo crudo image/jpeg, sin
 *   multipart, para que el ESP32 pueda enviarlos con un POST sencillo.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const { pool } = require('./db');
const auth = require('./auth');
const { exigirMiembro, autenticarDispositivo, rechazarDispositivo, quien, limpiarTexto } = auth;

// ===================== Configuracion =====================

const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

const DIR_FOTOS = process.env.FOTOS_DIR || path.join(__dirname, 'datos', 'fotos');
const FOTOS_DIAS = num(process.env.FOTOS_DIAS, 14);                       // cuanto se conservan
const FOTOS_MB_VIVIENDA = num(process.env.FOTOS_MB_VIVIENDA, 300);        // tope por vivienda
const FOTOS_MB_TOTAL = num(process.env.FOTOS_MB_TOTAL, 1500);             // tope de todo el servidor
const FOTOS_MIN_LIBRE_MB = num(process.env.FOTOS_MIN_LIBRE_MB, 1500);     // no guarda si queda menos libre
const FOTO_MAX_BYTES = num(process.env.FOTO_MAX_KB, 1024) * 1024;         // por imagen
const CUADRO_MAX_BYTES = num(process.env.CUADRO_MAX_KB, 150) * 1024;      // por cuadro en vivo
const VIVO_SESION_MAX_S = num(process.env.VIVO_SESION_MAX_S, 300);        // 5 min por sesion
const VIVO_DIA_MAX_MIN = num(process.env.VIVO_DIA_MAX_MIN, 60);           // 60 min por dia
const RAFAGA_ALARMA = num(process.env.CAMARA_RAFAGA, 3);                  // fotos por alarma
const CAMARA_EN_LINEA_S = 60;                                             // sin consultar mas de esto = desconectada
const ESPERA_MAX_S = 25;

let notificarFn = null;
let registrarAccionFn = null;
let notificarFotoFn = null;

/*
 * Enlaces firmados para mostrar una foto dentro de una notificacion push. El
 * sistema operativo descarga la imagen sin sesion, asi que el enlace lleva una
 * firma (HMAC) con caducidad corta y solo sirve para esa foto. El secreto se
 * genera al arrancar: tras un reinicio los enlaces pendientes dejan de valer,
 * lo cual es aceptable porque duran minutos.
 */
const SECRETO_FIRMA = crypto.randomBytes(32);
const FIRMA_TTL_S = 15 * 60;
function firmarFoto(id) {
  const exp = Math.floor(Date.now() / 1000) + FIRMA_TTL_S;
  const sig = crypto.createHmac('sha256', SECRETO_FIRMA).update(`${id}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}
function firmaValida(id, t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const esperada = crypto.createHmac('sha256', SECRETO_FIRMA).update(`${id}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ===================== Estado en memoria =====================

const esperando = new Map();   // viviendaId -> Set de { res, timer, camaraId }
const vivos = new Map();       // viviendaId -> { tareaId, sesionId, inicio, clientes:Set, cuadro, ultimoCliente }
const ultimaAuto = new Map();  // viviendaId -> instante de la ultima foto automatica

// ===================== Utilidades =====================

const esJpeg = (b) => Buffer.isBuffer(b) && b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const rutaFoto = (id) => path.join(DIR_FOTOS, String(Math.floor(id / 1000)), `${id}.jpg`);

async function borrarArchivo(id) {
  try { await fsp.unlink(rutaFoto(id)); } catch (e) { /* ya no existia */ }
}

async function borrarFotos(ids) {
  for (const id of ids) await borrarArchivo(id);
}

async function espacioLibreMB() {
  try {
    await fsp.mkdir(DIR_FOTOS, { recursive: true });
    const s = await fsp.statfs(DIR_FOTOS);
    return (s.bavail * s.bsize) / 1048576;
  } catch (e) {
    return Infinity;   // si no se puede medir, no se bloquea
  }
}

async function camaraEnLinea(viviendaId) {
  const r = await pool.query(
    `SELECT camara_id, ultimo_visto FROM camaras
      WHERE vivienda_id = $1 AND ultimo_visto > NOW() - ($2 || ' seconds')::interval
      ORDER BY ultimo_visto DESC LIMIT 1`, [viviendaId, String(CAMARA_EN_LINEA_S)]);
  return r.rowCount ? r.rows[0] : null;
}

// ===================== Tareas =====================

function despertarCamara(viviendaId) {
  const grupo = esperando.get(viviendaId);
  if (!grupo || grupo.size === 0) return;
  // Una sola camara atiende cada tarea
  const primera = grupo.values().next().value;
  grupo.delete(primera);
  clearTimeout(primera.timer);
  entregarTarea(viviendaId, primera.camaraId, primera.res).catch(() => {});
}

async function crearTarea(viviendaId, tipo, { motivo = null, sensorId = null, cantidad = 1, usuario = null } = {}) {
  const r = await pool.query(
    `INSERT INTO tareas_camara (vivienda_id, tipo, motivo, sensor_id, cantidad, usuario)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [viviendaId, tipo, motivo, sensorId, cantidad, usuario]);
  despertarCamara(viviendaId);
  return r.rows[0].id;
}

/*
 * Solicitud automatica por una alarma. No espera ni falla: la alerta al usuario
 * nunca debe depender de la camara (RF-15). Si no hay camara conectada, o ya se
 * pidio una foto hace poco, no hace nada.
 */
async function solicitarFotoAlarma(viviendaId, motivo, sensorId) {
  try {
    if (Date.now() - (ultimaAuto.get(viviendaId) || 0) < 15000) return;
    if (vivos.has(viviendaId)) return;
    if (!(await camaraEnLinea(viviendaId))) return;
    const pend = await pool.query(
      `SELECT 1 FROM tareas_camara WHERE vivienda_id = $1 AND tipo = 'foto' AND terminada_en IS NULL LIMIT 1`, [viviendaId]);
    if (pend.rowCount) return;
    ultimaAuto.set(viviendaId, Date.now());
    await crearTarea(viviendaId, 'foto', { motivo, sensorId, cantidad: RAFAGA_ALARMA, usuario: 'alarma' });
  } catch (e) {
    console.error('No se pudo solicitar la foto de la alarma:', e.message);
  }
}

// Cancela las tareas de foto que nadie atendio, para que no se tomen fotos viejas
async function caducarTareas() {
  await pool.query(
    `UPDATE tareas_camara SET terminada_en = NOW()
      WHERE terminada_en IS NULL AND tipo = 'foto'
        AND COALESCE(iniciada_en, creado_en) < NOW() - INTERVAL '60 seconds'`);
}

async function entregarTarea(viviendaId, camaraId, res) {
  if (res.writableEnded || res.destroyed) return;
  const r = await pool.query(
    `SELECT id, tipo, cantidad, tomadas FROM tareas_camara
      WHERE vivienda_id = $1 AND terminada_en IS NULL ORDER BY creado_en LIMIT 1`, [viviendaId]);
  if (!r.rowCount) return res.json({ ok: true, tarea: null });
  const t = r.rows[0];
  await pool.query('UPDATE tareas_camara SET iniciada_en = COALESCE(iniciada_en, NOW()) WHERE id = $1', [t.id]);
  if (t.tipo === 'foto') {
    return res.json({ ok: true, tarea: { id: t.id, tipo: 'foto', restantes: t.cantidad - t.tomadas, intervalo_ms: 700 } });
  }
  const v = vivos.get(viviendaId);
  const restante = v ? Math.max(0, VIVO_SESION_MAX_S - Math.floor((Date.now() - v.inicio) / 1000)) : 0;
  return res.json({ ok: true, tarea: { id: t.id, tipo: 'vivo', restante_s: restante } });
}

// ===================== Vista en vivo =====================

async function minutosVivoUsados(viviendaId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(fin, NOW()) - inicio))), 0) AS seg
       FROM sesiones_vivo WHERE vivienda_id = $1 AND inicio > NOW() - INTERVAL '24 hours'`, [viviendaId]);
  return Number(r.rows[0].seg) / 60;
}

async function cerrarVivo(viviendaId, motivo) {
  const v = vivos.get(viviendaId);
  if (!v) return;
  vivos.delete(viviendaId);
  for (const c of v.clientes) { try { c.end(); } catch (e) { /* ya cerrado */ } }
  await pool.query('UPDATE tareas_camara SET terminada_en = NOW() WHERE id = $1 AND terminada_en IS NULL', [v.tareaId]).catch(() => {});
  await pool.query('UPDATE sesiones_vivo SET fin = NOW() WHERE id = $1', [v.sesionId]).catch(() => {});
  console.log(`Vista en vivo cerrada en ${viviendaId}: ${motivo}`);
}

// Cierra por tiempo, o por falta de espectadores
function vigilarVivos() {
  const ahora = Date.now();
  for (const [id, v] of vivos) {
    if (ahora - v.inicio > VIVO_SESION_MAX_S * 1000) cerrarVivo(id, 'tiempo maximo de la sesion');
    else if (v.clientes.size === 0 && ahora - v.ultimoCliente > 20000) cerrarVivo(id, 'sin espectadores');
  }
}

// ===================== Almacenamiento =====================

/*
 * Aplica los topes de espacio: borra lo mas antiguo de una vivienda hasta que
 * quepa una imagen nueva, y despues lo mas antiguo de todo el servidor.
 */
async function hacerEspacio(viviendaId, bytesNuevos) {
  const limiteV = FOTOS_MB_VIVIENDA * 1048576;
  const ids = [];
  const sumV = await pool.query('SELECT COALESCE(SUM(bytes), 0)::bigint AS b FROM fotos WHERE vivienda_id = $1', [viviendaId]);
  let usado = Number(sumV.rows[0].b);
  if (usado + bytesNuevos > limiteV) {
    const viejas = await pool.query('SELECT id, bytes FROM fotos WHERE vivienda_id = $1 ORDER BY creado_en', [viviendaId]);
    for (const f of viejas.rows) {
      if (usado + bytesNuevos <= limiteV) break;
      ids.push(f.id); usado -= f.bytes;
    }
  }
  if (ids.length) {
    await pool.query('DELETE FROM fotos WHERE id = ANY($1::int[])', [ids]);
    await borrarFotos(ids);
    console.log(`Fotos antiguas eliminadas por el tope de la vivienda ${viviendaId}: ${ids.length}`);
  }
}

async function mantenimiento() {
  try {
    const caducas = await pool.query(
      `DELETE FROM fotos WHERE creado_en < NOW() - ($1 || ' days')::interval RETURNING id`, [String(FOTOS_DIAS)]);
    await borrarFotos(caducas.rows.map((f) => f.id));

    // Tope total: se descartan las mas antiguas de todo el servidor
    const limite = FOTOS_MB_TOTAL * 1048576;
    const tot = await pool.query('SELECT COALESCE(SUM(bytes), 0)::bigint AS b FROM fotos');
    let usado = Number(tot.rows[0].b);
    let extra = 0;
    if (usado > limite) {
      const viejas = await pool.query('SELECT id, bytes FROM fotos ORDER BY creado_en');
      const ids = [];
      for (const f of viejas.rows) {
        if (usado <= limite * 0.9) break;
        ids.push(f.id); usado -= f.bytes;
      }
      if (ids.length) {
        await pool.query('DELETE FROM fotos WHERE id = ANY($1::int[])', [ids]);
        await borrarFotos(ids);
        extra = ids.length;
      }
    }
    await pool.query(`DELETE FROM tareas_camara WHERE terminada_en < NOW() - INTERVAL '7 days'`);
    await pool.query(`DELETE FROM sesiones_vivo WHERE inicio < NOW() - INTERVAL '30 days'`);
    if (caducas.rowCount || extra) console.log(`Mantenimiento de fotos: ${caducas.rowCount} caducadas, ${extra} por espacio.`);
  } catch (e) {
    console.error('Error en el mantenimiento de fotos:', e.message);
  }
}

async function borrarFotosVivienda(viviendaId) {
  const r = await pool.query('SELECT id FROM fotos WHERE vivienda_id = $1', [viviendaId]);
  await borrarFotos(r.rows.map((f) => f.id));
  await cerrarVivo(viviendaId, 'vivienda eliminada');
}

async function iniciar() {
  await fsp.mkdir(DIR_FOTOS, { recursive: true });
  await mantenimiento();
  setInterval(mantenimiento, 3600000).unref();
  setInterval(vigilarVivos, 5000).unref();
  setInterval(() => caducarTareas().catch(() => {}), 15000).unref();
  console.log(`Camara lista. Fotos en ${DIR_FOTOS} (se conservan ${FOTOS_DIAS} dias, tope ${FOTOS_MB_VIVIENDA} MB por vivienda).`);
}

// ===================== Rutas =====================

function montarRutas(app, ganchos = {}) {
  notificarFn = ganchos.notificar;
  registrarAccionFn = ganchos.registrarAccion;
  notificarFotoFn = ganchos.notificarFoto;

  const cuerpoCrudo = (limite) => express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: limite });

  // ---------- Dispositivo: la camara ----------

  /*
   * GET /camara/tarea?camara_id=...&espera=20
   * La camara pregunta si hay algo que hacer. Con "espera" la peticion queda
   * abierta hasta ese numero de segundos esperando una tarea.
   */
  app.get('/camara/tarea', async (req, res) => {
    const disp = await autenticarDispositivo(req).catch(() => null);
    if (!disp) return rechazarDispositivo(res);
    const viviendaId = disp.viviendaId;
    const camaraId = limpiarTexto(req.query.camara_id, 40) || 'camara-1';
    const espera = Math.min(Math.max(Number(req.query.espera) || 0, 0), ESPERA_MAX_S);

    try {
      await pool.query(
        `INSERT INTO camaras (vivienda_id, camara_id) VALUES ($1, $2)
         ON CONFLICT (vivienda_id, camara_id) DO UPDATE SET ultimo_visto = NOW()`, [viviendaId, camaraId]);
      await caducarTareas();

      const hay = await pool.query(
        'SELECT 1 FROM tareas_camara WHERE vivienda_id = $1 AND terminada_en IS NULL LIMIT 1', [viviendaId]);
      if (hay.rowCount || espera === 0) return entregarTarea(viviendaId, camaraId, res);

      // Nada pendiente: se deja la peticion abierta
      const espero = { res, camaraId, timer: null };
      espero.timer = setTimeout(() => {
        const g = esperando.get(viviendaId);
        if (g) g.delete(espero);
        if (!res.writableEnded) res.json({ ok: true, tarea: null });
      }, espera * 1000);
      if (!esperando.has(viviendaId)) esperando.set(viviendaId, new Set());
      esperando.get(viviendaId).add(espero);
      res.on('close', () => {
        clearTimeout(espero.timer);
        const g = esperando.get(viviendaId);
        if (g) g.delete(espero);
      });
      // Se renueva la presencia mientras espera, para que no parezca desconectada
      espero.latido = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(espero.latido);
        pool.query('UPDATE camaras SET ultimo_visto = NOW() WHERE vivienda_id = $1 AND camara_id = $2', [viviendaId, camaraId]).catch(() => {});
      }, 20000);
      res.on('close', () => clearInterval(espero.latido));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, mensaje: 'No se pudo consultar la tarea.', detalle: e.message });
    }
  });

  /*
   * POST /camara/foto?tarea=ID&camara_id=...
   * Cuerpo: la imagen JPEG tal cual. Solo se aceptan fotos de una tarea abierta
   * de esta vivienda, para que un token filtrado no pueda llenar el disco.
   */
  app.post('/camara/foto', cuerpoCrudo(FOTO_MAX_BYTES), async (req, res) => {
    const disp = await autenticarDispositivo(req).catch(() => null);
    if (!disp) return rechazarDispositivo(res);
    const viviendaId = disp.viviendaId;
    const tareaId = Number(req.query.tarea);
    const imagen = req.body;

    if (!Number.isInteger(tareaId)) return res.status(400).json({ ok: false, mensaje: 'Falta el parametro "tarea".' });
    if (!esJpeg(imagen)) return res.status(400).json({ ok: false, mensaje: 'El cuerpo debe ser una imagen JPEG.' });

    try {
      const t = await pool.query(
        `SELECT id, motivo, sensor_id, cantidad, tomadas, usuario FROM tareas_camara
          WHERE id = $1 AND vivienda_id = $2 AND tipo = 'foto' AND terminada_en IS NULL`, [tareaId, viviendaId]);
      if (!t.rowCount) return res.status(409).json({ ok: false, mensaje: 'La tarea no existe o ya termino.', restantes: 0 });
      const tarea = t.rows[0];

      if ((await espacioLibreMB()) < FOTOS_MIN_LIBRE_MB) {
        await mantenimiento();
        if ((await espacioLibreMB()) < FOTOS_MIN_LIBRE_MB) {
          return res.status(507).json({ ok: false, mensaje: 'El servidor casi no tiene espacio libre. No se guardan mas fotos.' });
        }
      }
      await hacerEspacio(viviendaId, imagen.length);

      const camaraId = limpiarTexto(req.query.camara_id, 40);
      const f = await pool.query(
        `INSERT INTO fotos (vivienda_id, camara_id, tarea_id, motivo, sensor_id, bytes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [viviendaId, camaraId, tareaId, tarea.motivo, tarea.sensor_id, imagen.length]);
      const id = f.rows[0].id;
      try {
        const ruta = rutaFoto(id);
        await fsp.mkdir(path.dirname(ruta), { recursive: true });
        await fsp.writeFile(ruta, imagen);
      } catch (e) {
        await pool.query('DELETE FROM fotos WHERE id = $1', [id]);
        throw e;
      }

      // La primera foto de una alarma se manda en una notificacion, sin esperar
      // el resto de la rafaga. Si falla, no afecta a la foto ya guardada.
      if (tarea.usuario === 'alarma' && tarea.tomadas === 0 && notificarFotoFn) {
        Promise.resolve(notificarFotoFn(viviendaId, id, firmarFoto(id))).catch((e) => console.error('Push con foto:', e.message));
      }

      const tomadas = tarea.tomadas + 1;
      const termina = tomadas >= tarea.cantidad;
      await pool.query('UPDATE tareas_camara SET tomadas = $2, terminada_en = CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id = $1',
                       [tareaId, tomadas, termina]);
      return res.status(201).json({ ok: true, id, restantes: Math.max(0, tarea.cantidad - tomadas) });
    } catch (e) {
      console.error('Error al guardar la foto:', e.message);
      return res.status(500).json({ ok: false, mensaje: 'No se pudo guardar la foto.', detalle: e.message });
    }
  });

  /*
   * POST /camara/cuadro?tarea=ID
   * Un cuadro de la vista en vivo. La respuesta dice si debe seguir enviando.
   */
  app.post('/camara/cuadro', cuerpoCrudo(CUADRO_MAX_BYTES), async (req, res) => {
    const disp = await autenticarDispositivo(req).catch(() => null);
    if (!disp) return rechazarDispositivo(res);
    const v = vivos.get(disp.viviendaId);
    if (!v || v.tareaId !== Number(req.query.tarea)) return res.json({ ok: true, continuar: false });
    const imagen = req.body;
    if (!esJpeg(imagen)) return res.status(400).json({ ok: false, mensaje: 'El cuerpo debe ser una imagen JPEG.', continuar: true });

    v.cuadro = imagen;
    const cabecera = Buffer.from(`--cuadro\r\nContent-Type: image/jpeg\r\nContent-Length: ${imagen.length}\r\n\r\n`);
    for (const c of v.clientes) {
      // Si un espectador va lento se salta el cuadro en vez de acumularlos en memoria
      if (c.writableNeedDrain) continue;
      c.write(cabecera); c.write(imagen); c.write('\r\n');
    }
    const quedan = Math.max(0, VIVO_SESION_MAX_S - Math.floor((Date.now() - v.inicio) / 1000));
    return res.json({ ok: true, continuar: quedan > 0, restante_s: quedan });
  });

  // ---------- Persona: la aplicacion ----------

  app.get('/camara/estado', async (req, res) => {
    const viviendaId = req.query.vivienda_id;
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    try {
      const cam = await camaraEnLinea(viviendaId);
      const todas = await pool.query('SELECT COUNT(*)::int AS n FROM camaras WHERE vivienda_id = $1', [viviendaId]);
      const usados = await minutosVivoUsados(viviendaId);
      const v = vivos.get(viviendaId);
      res.json({
        ok: true,
        registrada: todas.rows[0].n > 0,
        en_linea: Boolean(cam),
        vivo: v ? { activo: true, restante_s: Math.max(0, VIVO_SESION_MAX_S - Math.floor((Date.now() - v.inicio) / 1000)) } : { activo: false },
        cuota: { usado_min: Math.round(usados * 10) / 10, max_min: VIVO_DIA_MAX_MIN, sesion_max_s: VIVO_SESION_MAX_S }
      });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo consultar la camara.', detalle: e.message });
    }
  });

  app.post('/camara/solicitar', async (req, res) => {
    const viviendaId = req.body && req.body.vivienda_id;
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    try {
      if (!(await camaraEnLinea(viviendaId))) {
        return res.status(409).json({ ok: false, mensaje: 'La cámara no está conectada.' });
      }
      const pend = await pool.query(
        `SELECT 1 FROM tareas_camara WHERE vivienda_id = $1 AND tipo = 'foto' AND terminada_en IS NULL LIMIT 1`, [viviendaId]);
      if (pend.rowCount) return res.status(429).json({ ok: false, mensaje: 'Ya hay una foto en camino.' });
      const id = await crearTarea(viviendaId, 'foto', { motivo: 'Foto solicitada', cantidad: 1, usuario: quien(req) });
      res.status(202).json({ ok: true, tarea_id: id });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo solicitar la foto.', detalle: e.message });
    }
  });

  app.get('/fotos', async (req, res) => {
    const viviendaId = req.query.vivienda_id;
    const limite = Math.min(Number(req.query.limite) || 24, 100);
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    try {
      const r = await pool.query(
        `SELECT id, motivo, sensor_id, bytes, creado_en FROM fotos WHERE vivienda_id = $1
          ORDER BY creado_en DESC LIMIT $2`, [viviendaId, limite]);
      res.json({ ok: true, total: r.rowCount, fotos: r.rows });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudieron consultar las fotos.', detalle: e.message });
    }
  });

  app.get('/fotos/:id/imagen', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, mensaje: 'Identificador invalido.' });
    try {
      const r = await pool.query('SELECT vivienda_id FROM fotos WHERE id = $1', [id]);
      if (!r.rowCount) return res.status(404).json({ ok: false, mensaje: 'Foto no encontrada.' });
      const firmada = req.query.t && firmaValida(id, req.query.t);
      if (!firmada && !(await exigirMiembro(req, res, r.rows[0].vivienda_id))) return;
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', firmada ? 'private, max-age=600' : 'private, max-age=86400, immutable');
      fs.createReadStream(rutaFoto(id))
        .on('error', () => { if (!res.headersSent) res.status(404).json({ ok: false, mensaje: 'El archivo ya no existe.' }); else res.end(); })
        .pipe(res);
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo leer la foto.', detalle: e.message });
    }
  });

  app.delete('/fotos/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, mensaje: 'Identificador invalido.' });
    try {
      const r = await pool.query('SELECT vivienda_id FROM fotos WHERE id = $1', [id]);
      if (!r.rowCount) return res.status(404).json({ ok: false, mensaje: 'Foto no encontrada.' });
      // Las fotos son evidencia: solo un propietario puede borrarlas
      if (!(await exigirMiembro(req, res, r.rows[0].vivienda_id, 'propietario'))) return;
      await pool.query('DELETE FROM fotos WHERE id = $1', [id]);
      await borrarArchivo(id);
      if (registrarAccionFn) await registrarAccionFn(r.rows[0].vivienda_id, 'foto_eliminada', id, '', quien(req));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo borrar la foto.', detalle: e.message });
    }
  });

  app.post('/camara/vivo/iniciar', async (req, res) => {
    const viviendaId = req.body && req.body.vivienda_id;
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    try {
      if (vivos.has(viviendaId)) return res.json({ ok: true, ya_activa: true });
      if (!(await camaraEnLinea(viviendaId))) return res.status(409).json({ ok: false, mensaje: 'La cámara no está conectada.' });
      const usados = await minutosVivoUsados(viviendaId);
      if (usados >= VIVO_DIA_MAX_MIN) {
        return res.status(429).json({ ok: false, mensaje: `Se agotó el tiempo de vista en vivo de hoy (${VIVO_DIA_MAX_MIN} min).`,
                                      usado_min: Math.round(usados), max_min: VIVO_DIA_MAX_MIN });
      }
      const usuario = quien(req);
      const tareaId = await crearTarea(viviendaId, 'vivo', { motivo: 'Vista en vivo', usuario });
      const s = await pool.query('INSERT INTO sesiones_vivo (vivienda_id, usuario) VALUES ($1, $2) RETURNING id', [viviendaId, usuario]);
      vivos.set(viviendaId, { tareaId, sesionId: s.rows[0].id, inicio: Date.now(), clientes: new Set(), cuadro: null, ultimoCliente: Date.now() });
      if (registrarAccionFn) await registrarAccionFn(viviendaId, 'vista_en_vivo', '', 'iniciada', usuario);
      const restanteDia = Math.max(0, VIVO_DIA_MAX_MIN - usados);
      res.status(201).json({ ok: true, max_s: Math.min(VIVO_SESION_MAX_S, Math.floor(restanteDia * 60)) });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudo iniciar la vista en vivo.', detalle: e.message });
    }
  });

  app.post('/camara/vivo/detener', async (req, res) => {
    const viviendaId = req.body && req.body.vivienda_id;
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    await cerrarVivo(viviendaId, 'detenida por el usuario');
    res.json({ ok: true });
  });

  /*
   * GET /camara/vivo?vivienda_id=...
   * Flujo MJPEG (multipart/x-mixed-replace): el navegador lo muestra con una
   * simple etiqueta <img>. La sesion se comprueba con la cookie.
   */
  app.get('/camara/vivo', async (req, res) => {
    const viviendaId = req.query.vivienda_id;
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    const v = vivos.get(viviendaId);
    if (!v) return res.status(404).json({ ok: false, mensaje: 'No hay una vista en vivo activa.' });
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=cuadro',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    v.clientes.add(res);
    v.ultimoCliente = Date.now();
    if (v.cuadro) {
      res.write(`--cuadro\r\nContent-Type: image/jpeg\r\nContent-Length: ${v.cuadro.length}\r\n\r\n`);
      res.write(v.cuadro); res.write('\r\n');
    }
    res.on('close', () => { v.clientes.delete(res); v.ultimoCliente = Date.now(); });
  });
}

module.exports = { montarRutas, iniciar, solicitarFotoAlarma, borrarFotosVivienda, firmarFoto, firmaValida };
