const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { iniciarCamaraFalsa } = require('./camara_onvif_falsa');
const { MotorEventos } = require('../onvif/estados');
const { ServicioOnvif } = require('../onvif/servicio');
const { ClienteOnvif } = require('../onvif/cliente');
const { crearRegistroXml } = require('../onvif/registro_xml');

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 4000, paso = 25) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperarMs(paso); }
  return false;
}

async function montar(opcCamara = {}, opcServicio = {}, opcMotor = {}) {
  const camara = await iniciarCamaraFalsa(opcCamara);
  const r = { eventos: [], alertas: [], diag: [], logs: [] };
  const motor = new MotorEventos({
    cooldownPersonaMs: 60000, cooldownMovimientoMs: 60000, dedupMs: 300, ventanaSyncMs: 1500, ...opcMotor,
    alEvento: (e) => r.eventos.push(e), alAlerta: (a) => r.alertas.push(a), alDiagnostico: (d) => r.diag.push(d)
  });
  const servicio = new ServicioOnvif({
    camaraId: 'c1', host: '127.0.0.1', puerto: camara.puerto, usuario: camara.usuario, clave: camara.clave,
    suscripcionS: 2, esperaS: 1, esperaMinReconexionMs: 100, esperaMaxReconexionMs: 400, ...opcServicio
  }, { motor, log: (n, m) => r.logs.push(`${n}: ${m}`) });
  servicio.iniciar();
  const cerrar = async () => { await servicio.detener(); await camara.cerrar(); };
  return { camara, motor, servicio, r, cerrar };
}
const tipos = (r, t) => r.diag.filter((d) => d.tipo === t).length;

test('conecta, corrige la hora de la camara, reescribe direcciones internas y sincroniza sin alertar', async () => {
  // La camara tiene el reloj 10 minutos adelantado: sin correccion rechazaria el digest
  const { camara, servicio, motor, r, cerrar } = await montar({ desfaseHoraMs: 10 * 60 * 1000 });
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false && motor.estado('c1').movimiento === false), 'no sincronizo');
    assert.equal(camara.contadores.crear, 1);
    assert.equal(camara.contadores.autenticacionFallida, 0);
    assert.equal(r.eventos.length, 0);
    assert.equal(r.alertas.length, 0);
    assert.equal(tipos(r, 'sincronizacion'), 2);
    // Las direcciones internas (192.168.4.2) no se usaron para conectar: llegaron peticiones a 127.0.0.1
    assert.ok(camara.xmlRecibidos.length >= 4);
    // wsa:To conserva la direccion original que dio la camara
    assert.ok(await hasta(() => camara.contadores.direcciones.length > 0));
    assert.ok(camara.contadores.direcciones.every((d) => d.startsWith('http://192.168.4.2:2020/onvif/subscription/')));
    // Topics verificados con GetEventProperties
    assert.deepEqual(servicio.estado().faltanTopics, []);
    assert.ok(servicio.estado().topicsCamara.some((t) => t.endsWith('PeopleDetector/People')));
    assert.ok(servicio.estado().topicsCamara.some((t) => t.endsWith('CellMotionDetector/Motion')));
  } finally { await cerrar(); }
});

test('persona entrando y saliendo del encuadre, con PropertyOperation siempre Initialized', async () => {
  const { camara, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    await esperarMs(1600);   // sale de la ventana de sincronizacion
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => r.alertas.length === 1));
    assert.equal(r.alertas[0].detector, 'persona');
    camara.emitir({ tipo: 'persona', valor: false });
    assert.ok(await hasta(() => r.eventos.length === 2));
    assert.deepEqual(r.eventos.map((e) => e.transicion), ['subida', 'bajada']);
    assert.ok(r.eventos.every((e) => e.operacion === 'Initialized'));
    assert.equal(r.eventos[0].topic, 'tns1:RuleEngine/PeopleDetector/People');
    assert.equal(r.eventos[0].regla, 'MyPeopleDetectorRule');
    assert.equal(motor.estado('c1').persona, false);
  } finally { await cerrar(); }
});

test('movimiento sin personas: una alerta de movimiento', async () => {
  const { camara, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').movimiento === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(() => r.alertas.length === 1));
    assert.equal(r.alertas[0].detector, 'movimiento');
  } finally { await cerrar(); }
});

test('detecciones simultaneas: una sola alerta, y ambos eventos quedan registrados', async () => {
  const { camara, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    await esperarMs(1600);
    camara.emitir({ tipo: 'movimiento', valor: true });
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => r.eventos.length === 2));
    await esperarMs(900);    // pasa la espera de deduplicacion
    assert.deepEqual(r.alertas.map((a) => a.detector), ['persona']);
  } finally { await cerrar(); }
});

test('mensajes Initialized repetidos con el mismo valor no generan nada', async () => {
  const { camara, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    for (let i = 0; i < 4; i++) camara.emitir({ tipo: 'persona', valor: false });
    assert.ok(await hasta(() => tipos(r, 'repetido') === 4));
    assert.equal(r.eventos.length, 0);
    assert.equal(r.alertas.length, 0);
  } finally { await cerrar(); }
});

test('la suscripcion se renueva sin reconectar: una sola creacion en varios ciclos', async () => {
  const { camara, servicio, cerrar } = await montar({}, { suscripcionS: 2 });   // renueva cada 1 s
  try {
    // El servicio cuenta la renovacion al recibir la respuesta, un instante despues de que la camara la recibe: se espera su contador
    assert.ok(await hasta(() => servicio.estado().renovaciones >= 2, 8000));
    assert.equal(camara.contadores.crear, 1);
    assert.equal(servicio.estado().conexiones, 1);
  } finally { await cerrar(); }
});

test('si la camara olvida la suscripcion, se recrea sola y vuelve a sincronizar sin alertar', async () => {
  const { camara, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    camara.olvidarSuscripciones();
    assert.ok(await hasta(() => camara.contadores.crear === 2, 6000), 'no recreo la suscripcion');
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    assert.equal(r.alertas.length, 0);
    assert.ok(tipos(r, 'desconectado') >= 1);
  } finally { await cerrar(); }
});

test('si la camara cae, el estado pasa a desconocido (no a "sin personas") y se recupera al volver', async () => {
  const { camara, motor, servicio, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    camara.caer();
    assert.ok(await hasta(() => motor.estado('c1').conectado === false, 6000), 'no detecto la caida');
    assert.deepEqual(motor.estado('c1'), { conectado: false, persona: null, movimiento: null });
    assert.ok(servicio.estado().errores >= 1);
    camara.recuperar();
    assert.ok(await hasta(() => motor.estado('c1').persona === false, 8000), 'no se reconecto');
    assert.equal(r.alertas.length, 0);
  } finally { await cerrar(); }
});

test('credenciales incorrectas: no se conecta, se registra el error y no se satura a la camara', async () => {
  const { camara, servicio, r, cerrar } = await montar({}, { clave: 'mala' });
  try {
    assert.ok(await hasta(() => camara.contadores.autenticacionFallida >= 2, 3000));
    assert.equal(servicio.estado().conectado, false);
    assert.ok(r.logs.some((l) => l.includes('credenciales')));
    assert.equal(camara.contadores.crear, 0);
  } finally { await cerrar(); }
});

test('el registro XML guarda los mensajes y oculta usuario, clave y nonce', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onvif-'));
  const ruta = path.join(dir, 'xml.log');
  const camara = await iniciarCamaraFalsa({ clave: 'claveSuperSecreta' });
  const cliente = new ClienteOnvif({
    host: '127.0.0.1', puerto: camara.puerto, usuario: camara.usuario, clave: camara.clave,
    registroXml: crearRegistroXml(ruta, { secretos: [camara.clave] })
  });
  try {
    await cliente.horaCamara();
    const ev = await cliente.direccionEventos();
    assert.equal(ev.original, 'http://192.168.4.2:2020/onvif/event_service');
    assert.equal(ev.url, `http://127.0.0.1:${camara.puerto}/onvif/event_service`);
    const log = fs.readFileSync(ruta, 'utf8');
    assert.ok(log.includes('GetServices'));
    assert.ok(log.includes('GetSystemDateAndTimeResponse'));
    assert.ok(!log.includes('claveSuperSecreta'));
    assert.ok(!/<wsse:Username>cam</.test(log));
    assert.ok(/<wsse:Password[^>]*>\*\*\*</.test(log));
    assert.ok(/<wsse:Nonce[^>]*>\*\*\*</.test(log));
  } finally { await camara.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('el servicio ONVIF no abre RTSP: el codigo no menciona RTSP ni el puerto 554', () => {
  const dir = path.join(__dirname, '..', 'onvif');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    assert.ok(!/rtsp|:554|ffmpeg/i.test(t), `${f} menciona RTSP o ffmpeg`);
  }
});

test('si la camara cierra el socket en una espera, se repite sin perder la suscripcion ni el estado', async () => {
  const { camara, servicio, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    camara.cortarPulls = 2;
    await esperarMs(100);
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => r.eventos.some((e) => e.detector === 'persona' && e.transicion === 'subida'), 6000), 'no llego el evento tras los cortes');
    assert.ok(await hasta(() => servicio.estado().cortesRecuperados >= 2, 4000), 'no se recuperaron los cortes');
    const est = servicio.estado();
    assert.equal(est.conexiones, 1, 'se creo otra suscripcion');
    assert.equal(motor.estado('c1').conectado, true);
    assert.ok(!r.logs.some((l) => /perdida/.test(l)), 'se declaro perdida la conexion');
  } finally { await cerrar(); }
});

test('si la camara cierra el socket al agotarse cada espera (camara en reposo), no se pierde la conexion ni se reconecta', async () => {
  const { camara, servicio, motor, r, cerrar } = await montar();
  try {
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    camara.cortarAlVencer = true;
    // Mas de 4 esperas vencidas seguidas: con el limite de 3 cortes seria un fallo si no se distinguieran
    assert.ok(await hasta(() => servicio.estado().esperasVencidas >= 5, 9000), 'no se acumularon esperas vencidas');
    const est = servicio.estado();
    assert.equal(est.conexiones, 1, 'se reconecto');
    assert.equal(est.errores, 0);
    assert.equal(motor.estado('c1').conectado, true);
    assert.equal(motor.estado('c1').persona, false);
    assert.ok(!r.logs.some((l) => /perdida/.test(l)));
    // Y al volver a haber eventos, siguen llegando
    camara.cortarAlVencer = false;
    camara.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => r.eventos.some((e) => e.detector === 'persona' && e.transicion === 'subida'), 4000));
  } finally { await cerrar(); }
});
