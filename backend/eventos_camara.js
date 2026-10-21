/*
 * Eventos de la camara: personas y movimiento detectados por la propia camara
 * (ONVIF), sin procesar video en este servidor.
 *
 * Une tres cosas:
 *   - el servicio ONVIF (onvif/servicio.js), que recibe los mensajes;
 *   - el motor de estados (onvif/estados.js), que decide que es un cambio real
 *     y cuando merece una alerta;
 *   - el resto del backend: base de datos, avisos y foto de evidencia.
 *
 * Politica por omision (se cambia con variables de entorno):
 *   - TODO cambio real queda en la tabla eventos_camara.
 *   - Solo AVISAN las personas (ONVIF_ALERTAR=persona). El movimiento se registra.
 *     Combinacion recomendada: ONVIF_SIRENA=persona (la persona hace sonar la alarma) y
 *     ONVIF_ALERTAR=persona,movimiento (el movimiento solo manda un aviso para que el
 *     residente mire la camara; suena como maximo una vez cada ONVIF_COOLDOWN_MOVIMIENTO_S).
 *   - Solo avisa con el sistema armado (ONVIF_SOLO_ARMADO=1): con alguien en casa
 *     una persona en el encuadre es lo normal.
 *   - NO activa la sirena. Solo si se pide con ONVIF_SIRENA=movimiento (o persona) y
 *     el sistema esta armado: entonces se marca la alarma y suena la salida audible
 *     por ONVIF_SIRENA_S segundos (ver activarAlarmaCamara en server.js). Una persona
 *     cuenta tambien como movimiento. Con ONVIF_SIRENA vacio nunca toca la alarma.
 *   - Retardo de salida: los primeros ONVIF_RETARDO_SALIDA_S segundos despues de armar
 *     no se avisa ni suena nada, para no disparar la alarma con el residente saliendo.
 *
 * Sin ONVIF_ACTIVO=1 este modulo no hace nada.
 */

const { pool } = require('./db');
const auth = require('./auth');
const { exigirMiembro } = auth;
const { MotorEventos } = require('./onvif/estados');
const { ServicioOnvif } = require('./onvif/servicio');
const { crearRegistroXml } = require('./onvif/registro_xml');

const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

function leerConfig(env = process.env) {
  const alertar = String(env.ONVIF_ALERTAR || 'persona').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    activo: env.ONVIF_ACTIVO === '1' || env.ONVIF_ACTIVO === 'true',
    viviendaId: env.ONVIF_VIVIENDA_ID || '',
    camaraId: env.ONVIF_CAMARA_ID || 'mc210',
    host: env.ONVIF_HOST || '10.8.0.2',
    puerto: num(env.ONVIF_PUERTO, 2020),
    usuario: env.ONVIF_USUARIO || '',
    clave: env.ONVIF_CLAVE || '',
    cooldownPersonaMs: num(env.ONVIF_COOLDOWN_PERSONA_S, 60) * 1000,
    cooldownMovimientoMs: num(env.ONVIF_COOLDOWN_MOVIMIENTO_S, 120) * 1000,
    dedupMs: num(env.ONVIF_DEDUP_MS, 3000),
    ventanaSyncMs: num(env.ONVIF_VENTANA_SYNC_MS, 5000),
    suscripcionS: num(env.ONVIF_SUSCRIPCION_S, 60),
    esperaS: num(env.ONVIF_LONGPOLL_S, 20),
    alertar: alertar.filter((x) => ['persona', 'movimiento'].includes(x)),
    sirena: String(env.ONVIF_SIRENA || '').split(',').map((x) => x.trim()).filter((x) => ['persona', 'movimiento'].includes(x)),
    sirenaS: num(env.ONVIF_SIRENA_S, 30),
    retardoSalidaS: Number.isFinite(Number(env.ONVIF_RETARDO_SALIDA_S)) && Number(env.ONVIF_RETARDO_SALIDA_S) >= 0 && env.ONVIF_RETARDO_SALIDA_S !== ''
      ? Number(env.ONVIF_RETARDO_SALIDA_S) : 60,
    soloArmado: !(env.ONVIF_SOLO_ARMADO === '0' || env.ONVIF_SOLO_ARMADO === 'false'),
    logXml: env.ONVIF_LOG_XML || '',
    diasEventos: num(env.ONVIF_EVENTOS_DIAS, 30)
  };
}

const TEXTOS = {
  persona: { titulo: 'Persona detectada', cuerpo: 'La camara detecto una persona', etiquetas: ['bust_in_silhouette'] },
  movimiento: { titulo: 'Movimiento detectado', cuerpo: 'La camara detecto movimiento', etiquetas: ['eyes'],
                // Un movimiento suelto no suena la alarma: se avisa para que el residente mire la camara y juzgue
                sugerencia: 'Abre la app para ver la camara y revisar si es algo serio.' }
};

let servicio = null;
let cfgActual = null;

/**
 * Arranca el servicio. Recibe del backend lo que necesita para avisar y pedir la foto,
 * en vez de importarlo, para no depender de server.js.
 */
function iniciar({ notificar, solicitarFoto, activarAlarma = null, config = leerConfig(), consulta = pool }) {
  cfgActual = config;
  if (!config.activo) {
    console.log('Eventos ONVIF desactivados (ONVIF_ACTIVO no es 1).');
    return null;
  }
  const faltan = ['viviendaId', 'usuario', 'clave'].filter((k) => !config[k]);
  if (faltan.length) {
    console.warn(`Eventos ONVIF activados pero faltan: ${faltan.map((k) => ({ viviendaId: 'ONVIF_VIVIENDA_ID', usuario: 'ONVIF_USUARIO', clave: 'ONVIF_CLAVE' }[k])).join(', ')}. No se inicia.`);
    return null;
  }

  const ultimoEvento = new Map();   // "camara|detector" -> promesa del id del evento guardado

  const motor = new MotorEventos({
    cooldownPersonaMs: config.cooldownPersonaMs,
    cooldownMovimientoMs: config.cooldownMovimientoMs,
    dedupMs: config.dedupMs,
    ventanaSyncMs: config.ventanaSyncMs,

    alEvento: (e) => {
      const p = consulta.query(
        `INSERT INTO eventos_camara (vivienda_id, camara_id, detector, valor, transicion, topic, regla, fuente, utc_camara)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [config.viviendaId, e.camaraId, e.detector, e.valor, e.transicion, e.topic || null, e.regla || null, e.fuente || null,
         e.utc && !Number.isNaN(Date.parse(e.utc)) ? new Date(e.utc) : null]
      ).then((r) => r.rows[0].id).catch((err) => { console.error('No se pudo guardar el evento de la camara:', err.message); return null; });
      // La alerta se asocia a la SUBIDA que la origino (la bajada puede llegar antes de que el movimiento avise)
      if (e.transicion === 'subida') ultimoEvento.set(`${e.camaraId}|${e.detector}`, p);
      console.log(`[onvif] ${e.detector} ${e.transicion} (${e.regla || e.topic || ''})`);
    },

    alAlerta: (a) => {
      decidirAviso(a).catch((err) => console.error('[onvif] Error al avisar de una deteccion:', err.message));
    },

    alDiagnostico: (d) => {
      // Solo lo que ayuda a entender el comportamiento sin llenar el registro
      if (['cooldown', 'movimiento_cubierto_por_persona', 'movimiento_absorbido_por_persona', 'ignorado_formato'].includes(d.tipo)) {
        console.log(`[onvif] ${d.tipo}${d.detector ? ` (${d.detector})` : ''}`);
      }
    }
  });

  // alerta: si el evento llego a avisar al residente (por omision, cuando no hay nota que explique por que no)
  async function marcarAlerta(a, nota, alerta = nota === null) {
    const id = await ultimoEvento.get(`${a.camaraId}|${a.detector}`);
    if (id) await consulta.query('UPDATE eventos_camara SET alerta = $2, nota = $3 WHERE id = $1', [id, alerta, nota]);
  }

  async function decidirAviso(a) {
    // Una persona implica movimiento: si la sirena esta pedida para el movimiento, la persona tambien suena.
    // (El motor descarta el aviso de movimiento cuando llega una persona, y sin esto el intruso no sonaria.)
    const suena = Boolean(activarAlarma) && (config.sirena.includes(a.detector) || (a.detector === 'persona' && config.sirena.includes('movimiento')));
    if (!suena && !config.alertar.includes(a.detector)) { await marcarAlerta(a, 'solo registrado por la politica'); return; }
    if (suena || config.soloArmado) {
      const r = await consulta.query('SELECT armado FROM estado_vivienda WHERE vivienda_id = $1', [config.viviendaId]);
      if (!r.rowCount || !r.rows[0].armado) { await marcarAlerta(a, 'sistema desarmado'); return; }
    }
    if (config.retardoSalidaS > 0) {
      const r = await consulta.query(
        `SELECT 1 FROM acciones WHERE vivienda_id = $1 AND accion = 'armar' AND valor_nuevo = 'true'
            AND creado_en > NOW() - ($2 || ' seconds')::interval LIMIT 1`, [config.viviendaId, String(config.retardoSalidaS)]);
      if (r.rowCount) { await marcarAlerta(a, 'retardo de salida'); return; }
    }
    const t = TEXTOS[a.detector];
    if (suena) {
      const r = await activarAlarma(config.viviendaId, t.cuerpo, config.sirenaS);
      if (r && r.avisado) await marcarAlerta(a, 'activo la alarma', true);
      else await marcarAlerta(a, (r && r.nota) || 'no se activo la alarma', false);
      return;
    }
    notificar(config.viviendaId, t.titulo, t.sugerencia ? `${t.cuerpo}. ${t.sugerencia}` : `${t.cuerpo}.`, 4, t.etiquetas);
    // La foto usa el mecanismo de evidencias existente; no bloquea ni falla el aviso
    solicitarFoto(config.viviendaId, t.cuerpo, null, { usuario: 'evento' });
    await marcarAlerta(a, null);
  }

  servicio = new ServicioOnvif({
    camaraId: config.camaraId, host: config.host, puerto: config.puerto, usuario: config.usuario, clave: config.clave,
    suscripcionS: config.suscripcionS, esperaS: config.esperaS,
    registroXml: crearRegistroXml(config.logXml, { secretos: [config.clave] })
  }, {
    motor,
    log: (nivel, msg) => (nivel === 'info' ? console.log : nivel === 'error' ? console.error : console.warn)(`[onvif] ${msg}`)
  });
  servicio.iniciar();

  // Limpieza de eventos antiguos, una vez por hora
  const limpiar = () => consulta.query(`DELETE FROM eventos_camara WHERE creado_en < NOW() - ($1 || ' days')::interval`, [String(config.diasEventos)])
    .catch((e) => console.error('[onvif] No se pudieron limpiar los eventos antiguos:', e.message));
  limpiar();
  setInterval(limpiar, 3600000).unref();

  console.log(`Eventos ONVIF activos: camara "${config.camaraId}" en ${config.host}:${config.puerto}, vivienda "${config.viviendaId}". ` +
    `Avisan: ${config.alertar.join(', ') || 'nada'}${config.soloArmado ? ' (solo con el sistema armado)' : ''}. ` +
    `Sirena: ${activarAlarma && config.sirena.length ? `${config.sirena.join(', ')} durante ${config.sirenaS} s` : 'no'}. Retardo de salida: ${config.retardoSalidaS} s.`);
  return servicio;
}

function montarRutas(app) {
  // Historial de eventos de la camara
  app.get('/camara/eventos', async (req, res) => {
    const viviendaId = req.query.vivienda_id;
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    try {
      const r = await pool.query(
        `SELECT id, camara_id, detector, valor, transicion, alerta, nota, creado_en FROM eventos_camara
          WHERE vivienda_id = $1 ORDER BY creado_en DESC LIMIT $2`, [viviendaId, limite]);
      res.json({ ok: true, total: r.rowCount, eventos: r.rows });
    } catch (e) {
      res.status(500).json({ ok: false, mensaje: 'No se pudieron consultar los eventos.', detalle: e.message });
    }
  });

  // Estado en vivo de la deteccion: null significa "desconocido", no "sin personas"
  app.get('/camara/deteccion', async (req, res) => {
    const viviendaId = req.query.vivienda_id;
    if (!(await exigirMiembro(req, res, viviendaId))) return;
    if (!servicio || !cfgActual || cfgActual.viviendaId !== viviendaId) {
      return res.json({ ok: true, activa: false });
    }
    const e = servicio.estado();
    res.json({
      ok: true, activa: true, conectado: e.conectado,
      persona: e.motor.persona, movimiento: e.motor.movimiento,
      ultimo_mensaje: e.ultimoMensajeMs ? new Date(e.ultimoMensajeMs).toISOString() : null,
      reconexiones: Math.max(0, e.conexiones - 1), errores: e.errores,
      politica: { alertar: cfgActual.alertar, sirena: cfgActual.sirena, sirena_s: cfgActual.sirenaS, retardo_salida_s: cfgActual.retardoSalidaS }
    });
  });
}

module.exports = { iniciar, montarRutas, leerConfig };
