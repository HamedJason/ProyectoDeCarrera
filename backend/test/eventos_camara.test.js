const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarCamaraFalsa } = require('./camara_onvif_falsa');
const eventosCamara = require('../eventos_camara');

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 4000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperarMs(25); }
  return false;
}

// Base de datos de mentira: anota todo y responde lo justo
function consultaFalsa({ armado, armarReciente = false }) {
  const c = { sql: [], eventos: [], actualizaciones: [], armado };
  let id = 0;
  c.query = async (sql, params = []) => {
    c.sql.push(sql);
    if (/INSERT INTO eventos_camara/.test(sql)) {
      const fila = { id: ++id, detector: params[2], valor: params[3], transicion: params[4] };
      c.eventos.push(fila);
      return { rows: [{ id: fila.id }], rowCount: 1 };
    }
    if (/UPDATE eventos_camara/.test(sql)) { c.actualizaciones.push({ id: params[0], alerta: params[1], nota: params[2] }); return { rows: [], rowCount: 1 }; }
    if (/SELECT armado/.test(sql)) return { rows: [{ armado: c.armado }], rowCount: 1 };
    if (/FROM acciones/.test(sql)) return { rows: armarReciente ? [{ '?column?': 1 }] : [], rowCount: armarReciente ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  };
  return c;
}

async function montar({ armado = true, env = {}, armarReciente = false, respuestaAlarma = { avisado: true, nota: null } } = {}) {
  const camara = await iniciarCamaraFalsa();
  const consulta = consultaFalsa({ armado, armarReciente });
  const avisos = [], fotos = [], activaciones = [];
  const config = eventosCamara.leerConfig({
    ONVIF_ACTIVO: '1', ONVIF_VIVIENDA_ID: 'casa-001', ONVIF_HOST: '127.0.0.1', ONVIF_PUERTO: String(camara.puerto),
    ONVIF_USUARIO: camara.usuario, ONVIF_CLAVE: camara.clave,
    ONVIF_SUSCRIPCION_S: '2', ONVIF_LONGPOLL_S: '1', ONVIF_DEDUP_MS: '300', ONVIF_VENTANA_SYNC_MS: '1500', ...env
  });
  const servicio = eventosCamara.iniciar({
    config, consulta,
    notificar: (...a) => avisos.push(a),
    solicitarFoto: (...a) => fotos.push(a),
    activarAlarma: async (...a) => { activaciones.push(a); return respuestaAlarma; }
  });
  const cerrar = async () => { await servicio.detener(); await camara.cerrar(); };
  return { camara, consulta, avisos, fotos, activaciones, servicio, cerrar };
}

test('persona con el sistema armado: guarda el evento, avisa y pide foto como evento (no como alarma)', async () => {
  const { camara, consulta, avisos, fotos, servicio, cerrar } = await montar({ armado: true });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.persona === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => avisos.length === 1));
    assert.equal(avisos[0][0], 'casa-001');
    assert.equal(avisos[0][1], 'Persona detectada');
    assert.equal(fotos.length, 1);
    assert.deepEqual(fotos[0].slice(0, 2), ['casa-001', 'La camara detecto una persona']);
    assert.deepEqual(fotos[0][3], { usuario: 'evento' });
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.alerta === true)));
    assert.equal(consulta.eventos[0].detector, 'persona');
    assert.equal(consulta.eventos[0].transicion, 'subida');
  } finally { await cerrar(); }
});

test('persona con el sistema desarmado: queda registrada pero no avisa ni pide foto', async () => {
  const { camara, consulta, avisos, fotos, servicio, cerrar } = await montar({ armado: false });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.persona === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.nota === 'sistema desarmado')));
    assert.equal(avisos.length, 0);
    assert.equal(fotos.length, 0);
    assert.equal(consulta.eventos.length, 1);
  } finally { await cerrar(); }
});

test('movimiento sin personas: se registra y, por la politica por omision, no avisa', async () => {
  const { camara, consulta, avisos, servicio, cerrar } = await montar({ armado: true });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.nota === 'solo registrado por la politica'), 3000));
    assert.equal(avisos.length, 0);
    assert.equal(consulta.eventos.filter((e) => e.detector === 'movimiento').length, 1);
  } finally { await cerrar(); }
});

test('con ONVIF_ALERTAR=persona,movimiento el movimiento si avisa', async () => {
  const { camara, avisos, servicio, cerrar } = await montar({ armado: true, env: { ONVIF_ALERTAR: 'persona,movimiento' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => avisos.length === 1, 3000));
    assert.equal(avisos[0][1], 'Movimiento detectado');
  } finally { await cerrar(); }
});

test('una deteccion nunca toca la alarma ni la sirena', async () => {
  const { camara, consulta, servicio, cerrar } = await montar({ armado: true, env: { ONVIF_ALERTAR: 'persona,movimiento' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.persona === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'persona', valor: true });
    camara.emitir({ tipo: 'movimiento', valor: true });
    await esperarMs(1000);
    assert.ok(consulta.sql.length > 0);
    assert.ok(consulta.sql.every((s) => !/estado_vivienda\b.*(UPDATE|SET)|UPDATE\s+estado_vivienda|alarma_activa|actuador/i.test(s)),
      'una consulta modifica el estado de la alarma');
  } finally { await cerrar(); }
});

test('sin ONVIF_ACTIVO no arranca nada, y con datos incompletos tampoco', () => {
  const sin = eventosCamara.iniciar({ config: eventosCamara.leerConfig({}), consulta: consultaFalsa({}), notificar() {}, solicitarFoto() {} });
  assert.equal(sin, null);
  const incompleto = eventosCamara.iniciar({
    config: eventosCamara.leerConfig({ ONVIF_ACTIVO: '1', ONVIF_VIVIENDA_ID: 'casa-001' }),
    consulta: consultaFalsa({}), notificar() {}, solicitarFoto() {}
  });
  assert.equal(incompleto, null);
});

test('leerConfig: valores por omision seguros', () => {
  const c = eventosCamara.leerConfig({});
  assert.equal(c.activo, false);
  assert.deepEqual(c.alertar, ['persona']);
  assert.equal(c.soloArmado, true);
  assert.equal(c.host, '10.8.0.2');
  assert.equal(c.puerto, 2020);
  assert.equal(c.cooldownPersonaMs, 60000);
});

test('ONVIF_SIRENA=movimiento con el sistema armado: el movimiento activa la alarma (no un aviso comun)', async () => {
  const { camara, consulta, avisos, fotos, activaciones, servicio, cerrar } = await montar({ armado: true, env: { ONVIF_SIRENA: 'movimiento', ONVIF_SIRENA_S: '20', ONVIF_RETARDO_SALIDA_S: '0' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => activaciones.length === 1, 3000));
    assert.deepEqual(activaciones[0], ['casa-001', 'La camara detecto movimiento', 20]);
    assert.equal(avisos.length, 0, 'el aviso lo da la propia alarma, no un aviso aparte');
    assert.equal(fotos.length, 0);
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.alerta === true)));
  } finally { await cerrar(); }
});

test('con la sirena pedida para el movimiento, una persona tambien suena (una persona implica movimiento) y solo una vez', async () => {
  const { camara, activaciones, servicio, cerrar } = await montar({ armado: true, env: { ONVIF_SIRENA: 'movimiento', ONVIF_RETARDO_SALIDA_S: '0' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.persona === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'persona', valor: true });
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => activaciones.length >= 1, 3000));
    await esperarMs(1200);
    assert.equal(activaciones.length, 1);
  } finally { await cerrar(); }
});

test('la sirena exige el sistema armado: desarmado se registra y no suena', async () => {
  const { camara, consulta, activaciones, avisos, servicio, cerrar } = await montar({ armado: false, env: { ONVIF_SIRENA: 'movimiento', ONVIF_RETARDO_SALIDA_S: '0' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.nota === 'sistema desarmado'), 3000));
    assert.equal(activaciones.length, 0);
    assert.equal(avisos.length, 0);
  } finally { await cerrar(); }
});

test('retardo de salida: justo despues de armar no suena ni avisa', async () => {
  const { camara, consulta, activaciones, avisos, servicio, cerrar } = await montar({ armado: true, armarReciente: true, env: { ONVIF_SIRENA: 'movimiento', ONVIF_RETARDO_SALIDA_S: '60' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.nota === 'retardo de salida'), 3000));
    assert.equal(activaciones.length, 0);
    assert.equal(avisos.length, 0);
  } finally { await cerrar(); }
});

test('sin ONVIF_SIRENA la camara nunca activa la alarma, aunque el backend pueda hacerlo', async () => {
  const { camara, activaciones, avisos, servicio, cerrar } = await montar({ armado: true, env: { ONVIF_ALERTAR: 'persona,movimiento', ONVIF_RETARDO_SALIDA_S: '0' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.persona === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => avisos.length === 1, 3000));
    assert.equal(activaciones.length, 0);
  } finally { await cerrar(); }
});

test('si la alarma no se pudo activar (ya habia una), el evento queda registrado con esa nota y sin alerta', async () => {
  const { camara, consulta, servicio, cerrar } = await montar({ armado: true, env: { ONVIF_SIRENA: 'movimiento', ONVIF_RETARDO_SALIDA_S: '0' },
    respuestaAlarma: { avisado: false, nota: 'ya habia una alarma activa' } });
  try {
    assert.ok(await hasta(() => servicio.estado().motor.movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => consulta.actualizaciones.some((u) => u.nota === 'ya habia una alarma activa' && u.alerta === false), 3000));
  } finally { await cerrar(); }
});

test('leerConfig: sirena apagada por omision, 30 s y retardo de salida de 60 s', () => {
  const c = eventosCamara.leerConfig({});
  assert.deepEqual(c.sirena, []);
  assert.equal(c.sirenaS, 30);
  assert.equal(c.retardoSalidaS, 60);
  assert.deepEqual(eventosCamara.leerConfig({ ONVIF_SIRENA: 'movimiento, persona, otra' }).sirena, ['movimiento', 'persona']);
  assert.equal(eventosCamara.leerConfig({ ONVIF_RETARDO_SALIDA_S: '0' }).retardoSalidaS, 0);
});
