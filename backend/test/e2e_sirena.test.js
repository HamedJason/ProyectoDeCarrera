// Prueba de extremo a extremo de la alarma disparada por la camara (servidor REAL, PGlite y camara ONVIF
// simulada). Es lo mas delicado del modulo porque enciende la salida audible: comprueba que la salida se
// apaga sola, al apagar la alarma, al desarmar y tras reiniciar el servidor, y que el retardo de salida y el
// sistema desarmado impiden que suene.
// Necesita @electric-sql/pglite y @electric-sql/pglite-socket; sin ellos se omite.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let PGlite, PGLiteSocketServer;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
  ({ PGLiteSocketServer } = require('@electric-sql/pglite-socket'));
} catch (e) { /* se omite abajo */ }

const { iniciarCamaraFalsa } = require('./camara_onvif_falsa');

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 15000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperarMs(100); }
  return false;
}
const puertoLibre = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('alarma por camara: suena armado, se apaga sola, desde la app, al desarmar y tras un reinicio', { skip: !PGlite && 'falta PGlite', timeout: 120000 }, async (t) => {
  const db = await PGlite.create();
  const sockDb = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 10 });
  await sockDb.start();
  const puertoDb = Number((String(sockDb.getServerConn()).match(/(\d+)$/) || [])[1]);
  assert.ok(puertoDb, 'no se obtuvo el puerto de la base');

  const camaraOnvif = await iniciarCamaraFalsa();
  const dirFotos = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-sirena-'));
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  let salida = '';
  let servidor = null;
  // "Camara" que solo acepta conexiones TCP: con ella el agente interno (imagen de prueba) figura en linea
  const alcance = net.createServer((c) => c.destroy());
  await new Promise((r) => alcance.listen(0, '127.0.0.1', r));

  const lanzar = (extra = {}) => {
    const s = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: `postgresql://postgres@127.0.0.1:${puertoDb}/postgres`, PGSSL: 'off',
        DEVICE_TOKEN: 'token-global', PORT: String(puerto), FOTOS_DIR: dirFotos, FOTOS_MIN_LIBRE_MB: '1',
        ONVIF_ACTIVO: '1', ONVIF_VIVIENDA_ID: 'casa-001', ONVIF_HOST: '127.0.0.1', ONVIF_PUERTO: String(camaraOnvif.puerto),
        ONVIF_USUARIO: camaraOnvif.usuario, ONVIF_CLAVE: camaraOnvif.clave,
        ONVIF_SUSCRIPCION_S: '4', ONVIF_LONGPOLL_S: '1', ONVIF_VENTANA_SYNC_MS: '1200', ONVIF_DEDUP_MS: '300',
        ONVIF_COOLDOWN_MOVIMIENTO_S: '1', ONVIF_COOLDOWN_PERSONA_S: '1',
        ONVIF_SIRENA: 'movimiento', ONVIF_SIRENA_S: '3', ONVIF_RETARDO_SALIDA_S: '0',
        CAMARA_RTSP_ACTIVO: '1', RTSP_HOST: '127.0.0.1', RTSP_PUERTO: String(alcance.address().port),
        CAMARA_FUENTE_PRUEBA: '1', CAMARA_ESPERA_S: '2', CAMARA_PAUSA_RECHAZO_S: '1', CAMARA_RAFAGA: '2',
        ...extra
      }
    });
    s.stdout.on('data', (d) => { salida += d; });
    s.stderr.on('data', (d) => { salida += d; });
    return s;
  };
  const esperarSalud = () => hasta(async () => { try { return (await fetch(`${base}/salud`)).ok; } catch (e) { return false; } }, 30000);
  const matar = (s) => new Promise((r) => { if (!s || s.exitCode !== null) return r(); s.once('exit', r); s.kill('SIGKILL'); });

  t.after(async () => {
    await matar(servidor);
    alcance.close();
    await camaraOnvif.cerrar();
    await esperarMs(600);   // deja terminar las consultas que el servidor muerto tenia en vuelo
    await sockDb.stop();
    await db.close();
    fs.rmSync(dirFotos, { recursive: true, force: true });
  });

  const estado = async () => (await db.query(`SELECT armado, actuador_activo, alarma_activa, alarma_motivo, alarma_sensor FROM estado_vivienda WHERE vivienda_id = 'casa-001'`)).rows[0];
  // El estado se marca primero y el historial se escribe un instante despues: se espera el registro
  const hayAccion = (pred, ms = 6000) => hasta(async () => (await acciones()).some(pred), ms);
  const acciones = async () => (await db.query(`SELECT accion, valor_nuevo, usuario FROM acciones WHERE vivienda_id = 'casa-001' ORDER BY id`)).rows;
  // Un movimiento nuevo: baja y sube, y se espera mas que el enfriamiento de 1 s
  const moverse = async () => {
    camaraOnvif.emitir({ tipo: 'movimiento', valor: false });
    await esperarMs(1300);
    camaraOnvif.emitir({ tipo: 'movimiento', valor: true });
  };
  const armar = (valor) => db.query(`UPDATE estado_vivienda SET armado = $1 WHERE vivienda_id = 'casa-001'`, [valor]);

  try {
    servidor = lanzar();
    assert.ok(await esperarSalud(), `el servidor no arranco:\n${salida.slice(-1500)}`);

    await db.query(`INSERT INTO viviendas (id, nombre) VALUES ('casa-001', 'Casa 001') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO estado_vivienda (vivienda_id, armado) VALUES ('casa-001', true) ON CONFLICT (vivienda_id) DO UPDATE SET armado = true`);
    const reg = await fetch(`${base}/auth/registro`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dueno@ejemplo.com', nombre: 'Dueno', clave: 'clave-segura-123' }) });
    assert.ok(reg.status < 300, `registro: ${await reg.text()}`);
    const ent = await fetch(`${base}/auth/entrar`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dueno@ejemplo.com', clave: 'clave-segura-123' }) });
    const cookie = (ent.headers.getSetCookie ? ent.headers.getSetCookie() : [ent.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
    const post = (ruta, cuerpo) => fetch(`${base}${ruta}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(cuerpo) });
    const apagarDesdeApp = () => post('/estado', { vivienda_id: 'casa-001', alarma_activa: false });
    const api = (ruta) => fetch(`${base}${ruta}`, { headers: { cookie } }).then((r) => r.json());

    // La camara se sincroniza, el agente figura en linea y todo esta en reposo
    assert.ok(await hasta(async () => (await db.query(`SELECT 1 FROM camaras WHERE camara_id = 'mc210'`)).rows.length === 1), `el agente de la camara no figura en linea:\n${salida.slice(-1500)}`);
    assert.ok(await hasta(async () => (await api('/camara/deteccion?vivienda_id=casa-001')).movimiento === false), `no se sincronizo:\n${salida.slice(-1500)}`);
    await esperarMs(1400);
    let e = await estado();
    assert.equal(e.alarma_activa, false);
    assert.equal(e.actuador_activo, false);

    // --- Movimiento con el sistema armado: suena
    camaraOnvif.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(async () => (await estado()).alarma_activa === true, 8000), `la alarma no se activo:\n${salida.slice(-1500)}`);
    e = await estado();
    assert.equal(e.actuador_activo, true, 'la salida audible no se encendio');
    assert.equal(e.alarma_sensor, 'camara');
    assert.match(e.alarma_motivo, /movimiento/i);
    assert.ok(await hayAccion((a) => a.accion === 'alarma_activada' && a.usuario === 'camara'), 'no quedo en el historial la alarma activada');
    assert.ok(await hayAccion((a) => a.accion === 'salida_audible' && a.valor_nuevo === 'true' && a.usuario === 'camara'), 'no quedo en el historial la salida encendida');
    // La foto de evidencia de la alarma llega por el mecanismo de siempre
    assert.ok(await hasta(async () => (await db.query(`SELECT 1 FROM fotos WHERE vivienda_id = 'casa-001'`)).rows.length >= 2, 25000), `no se guardaron las fotos de la alarma:\n${salida.slice(-1500)}`);

    // --- Se apaga sola al cumplirse el tiempo (3 s)
    assert.ok(await hasta(async () => (await estado()).actuador_activo === false, 8000), 'la salida no se apago sola');
    e = await estado();
    assert.equal(e.alarma_activa, false);
    assert.equal(e.alarma_sensor, null);
    assert.ok(await hayAccion((a) => a.accion === 'alarma_terminada' && a.usuario === 'camara'), 'no quedo en el historial la alarma terminada');
    assert.ok(await hayAccion((a) => a.accion === 'salida_audible' && a.valor_nuevo === 'false' && a.usuario === 'camara'), 'no quedo en el historial la salida apagada');

    // --- Apagarla desde la app apaga tambien la salida, y el temporizador no actua despues
    await moverse();
    assert.ok(await hasta(async () => (await estado()).alarma_activa === true, 8000), 'la segunda alarma no se activo');
    assert.equal((await estado()).actuador_activo, true);
    const r = await apagarDesdeApp();
    assert.equal(r.status, 200);
    e = await estado();
    assert.equal(e.alarma_activa, false);
    assert.equal(e.actuador_activo, false, 'apagar la alarma desde la app dejo la salida encendida');
    const terminadasAntes = (await acciones()).filter((a) => a.accion === 'alarma_terminada').length;
    await esperarMs(3600);   // pasa el tiempo del temporizador cancelado
    assert.equal((await acciones()).filter((a) => a.accion === 'alarma_terminada').length, terminadasAntes, 'el temporizador actuo despues de apagar la alarma');

    // --- Desarmar el sistema con la alarma sonando apaga la salida
    await moverse();
    assert.ok(await hasta(async () => (await estado()).alarma_activa === true, 8000), 'la tercera alarma no se activo');
    const d = await post('/estado', { vivienda_id: 'casa-001', armado: false });
    assert.equal(d.status, 200);
    e = await estado();
    assert.equal(e.alarma_activa, false);
    assert.equal(e.actuador_activo, false, 'desarmar dejo la salida encendida');

    // --- Desarmado no suena, aunque la camara detecte movimiento
    await moverse();
    assert.ok(await hasta(async () => (await db.query(`SELECT 1 FROM eventos_camara WHERE nota = 'sistema desarmado'`)).rows.length >= 1, 6000));
    e = await estado();
    assert.equal(e.alarma_activa, false);
    assert.equal(e.actuador_activo, false);

    // --- Reinicio del servidor mientras suena: al arrancar no queda nada encendido
    await armar(true);
    await moverse();
    assert.ok(await hasta(async () => (await estado()).alarma_activa === true, 8000), 'la alarma del reinicio no se activo');
    assert.equal((await estado()).actuador_activo, true);
    await matar(servidor);                       // el servidor cae con la salida encendida: no habra temporizador
    assert.equal((await estado()).actuador_activo, true, 'preparacion: debe seguir encendida tras la caida');
    servidor = lanzar();
    assert.ok(await esperarSalud(), `el servidor no volvio a arrancar:\n${salida.slice(-1500)}`);
    e = await estado();
    assert.equal(e.alarma_activa, false, 'la alarma siguio marcada tras el reinicio');
    assert.equal(e.actuador_activo, false, 'la salida siguio encendida tras el reinicio');
    assert.ok(await hayAccion((a) => a.accion === 'alarma_terminada' && /reinicio/.test(a.usuario)), 'no quedo en el historial el apagado por reinicio');
  } catch (err) {
    err.message += `\n--- Salida del servidor ---\n${salida.slice(-2500)}`;
    throw err;
  }
});

test('retardo de salida: recien armado no suena, y pasado el retardo si', { skip: !PGlite && 'falta PGlite', timeout: 120000 }, async (t) => {
  const db = await PGlite.create();
  const sockDb = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 10 });
  await sockDb.start();
  const puertoDb = Number((String(sockDb.getServerConn()).match(/(\d+)$/) || [])[1]);
  const camaraOnvif = await iniciarCamaraFalsa();
  const dirFotos = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-retardo-'));
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  let salida = '';
  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, DATABASE_URL: `postgresql://postgres@127.0.0.1:${puertoDb}/postgres`, PGSSL: 'off',
      DEVICE_TOKEN: 'token-global', PORT: String(puerto), FOTOS_DIR: dirFotos, FOTOS_MIN_LIBRE_MB: '1',
      ONVIF_ACTIVO: '1', ONVIF_VIVIENDA_ID: 'casa-001', ONVIF_HOST: '127.0.0.1', ONVIF_PUERTO: String(camaraOnvif.puerto),
      ONVIF_USUARIO: camaraOnvif.usuario, ONVIF_CLAVE: camaraOnvif.clave,
      ONVIF_SUSCRIPCION_S: '4', ONVIF_LONGPOLL_S: '1', ONVIF_VENTANA_SYNC_MS: '1200', ONVIF_DEDUP_MS: '300',
      ONVIF_COOLDOWN_MOVIMIENTO_S: '1', ONVIF_SIRENA: 'movimiento', ONVIF_SIRENA_S: '2', ONVIF_RETARDO_SALIDA_S: '5'
    }
  });
  servidor.stdout.on('data', (d) => { salida += d; });
  servidor.stderr.on('data', (d) => { salida += d; });
  t.after(async () => {
    servidor.kill('SIGKILL'); await camaraOnvif.cerrar(); await esperarMs(600); await sockDb.stop(); await db.close();
    fs.rmSync(dirFotos, { recursive: true, force: true });
  });

  try {
    assert.ok(await hasta(async () => { try { return (await fetch(`${base}/salud`)).ok; } catch (e) { return false; } }, 30000), `no arranco:\n${salida.slice(-1500)}`);
    await db.query(`INSERT INTO viviendas (id, nombre) VALUES ('casa-001', 'Casa 001') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO estado_vivienda (vivienda_id, armado) VALUES ('casa-001', true) ON CONFLICT (vivienda_id) DO UPDATE SET armado = true`);
    // Como si el residente acabara de armar desde la aplicacion
    await db.query(`INSERT INTO acciones (vivienda_id, accion, valor_anterior, valor_nuevo, usuario) VALUES ('casa-001', 'armar', 'false', 'true', 'residente')`);
    await esperarMs(2500);   // la camara ya sincronizo

    camaraOnvif.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(async () => (await db.query(`SELECT 1 FROM eventos_camara WHERE nota = 'retardo de salida'`)).rows.length === 1, 6000),
      `no se aplico el retardo de salida:\n${salida.slice(-1500)}`);
    const e1 = (await db.query(`SELECT alarma_activa, actuador_activo FROM estado_vivienda WHERE vivienda_id = 'casa-001'`)).rows[0];
    assert.equal(e1.alarma_activa, false);
    assert.equal(e1.actuador_activo, false);

    // Pasado el retardo, el mismo movimiento si dispara la alarma
    await db.query(`UPDATE acciones SET creado_en = NOW() - INTERVAL '10 minutes' WHERE accion = 'armar'`);
    camaraOnvif.emitir({ tipo: 'movimiento', valor: false });
    await esperarMs(1300);
    camaraOnvif.emitir({ tipo: 'movimiento', valor: true });
    assert.ok(await hasta(async () => (await db.query(`SELECT alarma_activa FROM estado_vivienda WHERE vivienda_id = 'casa-001'`)).rows[0].alarma_activa === true, 8000),
      `no sono pasado el retardo:\n${salida.slice(-1500)}`);
  } catch (err) {
    err.message += `\n--- Salida del servidor ---\n${salida.slice(-2500)}`;
    throw err;
  }
});
