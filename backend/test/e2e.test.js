/*
 * Prueba de extremo a extremo: el servidor REAL (server.js) contra un PostgreSQL
 * en memoria (PGlite), con la camara ONVIF simulada y ffmpeg real como fuente de
 * imagen. Comprueba el camino completo de una deteccion:
 *
 *   camara ONVIF -> servicio ONVIF -> evento en la base -> aviso -> tarea de foto
 *   -> agente de la camara (ffmpeg) -> fotos guardadas -> visibles por la API
 *
 * Necesita las dependencias de desarrollo (@electric-sql/pglite y
 * @electric-sql/pglite-socket). Sin ellas, la prueba se omite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let PGlite, PGLiteSocketServer;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
  ({ PGLiteSocketServer } = require('@electric-sql/pglite-socket'));
} catch (e) { /* se omite abajo */ }
const hayFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

const { iniciarCamaraFalsa } = require('./camara_onvif_falsa');
const { AgenteCamara, leerConfig } = require('../camara_rtsp');

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 15000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperarMs(100); }
  return false;
}
const puertoLibre = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('deteccion de persona de punta a punta, sin tocar la alarma', { skip: !(PGlite && hayFfmpeg) && 'faltan PGlite o ffmpeg', timeout: 90000 }, async (t) => {
  // --- Base de datos en memoria
  const db = await PGlite.create();
  const sockDb = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 10 });
  await sockDb.start();
  const puertoDb = Number((String(sockDb.getServerConn()).match(/(\d+)$/) || [])[1]) || null;
  assert.ok(puertoDb, 'no se obtuvo el puerto de la base');

  const camaraOnvif = await iniciarCamaraFalsa();
  const dirFotos = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-e2e-'));
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  let salida = '';

  // --- Servidor real
  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: `postgresql://postgres@127.0.0.1:${puertoDb}/postgres`, PGSSL: 'off',
      DEVICE_TOKEN: 'token-global', PORT: String(puerto), FOTOS_DIR: dirFotos, FOTOS_MIN_LIBRE_MB: '1',
      CAMARA_RAFAGA: '3',
      ONVIF_ACTIVO: '1', ONVIF_VIVIENDA_ID: 'casa-001', ONVIF_HOST: '127.0.0.1', ONVIF_PUERTO: String(camaraOnvif.puerto),
      ONVIF_USUARIO: camaraOnvif.usuario, ONVIF_CLAVE: camaraOnvif.clave,
      ONVIF_SUSCRIPCION_S: '4', ONVIF_LONGPOLL_S: '1', ONVIF_VENTANA_SYNC_MS: '1500', ONVIF_DEDUP_MS: '300'
    }
  });
  servidor.stdout.on('data', (d) => { salida += d; });
  servidor.stderr.on('data', (d) => { salida += d; });

  let agente = null;
  t.after(async () => {
    if (agente) await agente.detener();
    servidor.kill('SIGKILL');
    await camaraOnvif.cerrar();
    await sockDb.stop();
    await db.close();
    fs.rmSync(dirFotos, { recursive: true, force: true });
  });

  try {
    assert.ok(await hasta(async () => { try { return (await fetch(`${base}/salud`)).ok; } catch (e) { return false; } }, 30000),
      `el servidor no arranco:\n${salida.slice(-1500)}`);

    // La vivienda, armada, y una cuenta propietaria para consultar la API
    await db.query(`INSERT INTO viviendas (id, nombre) VALUES ('casa-001', 'Casa 001') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO estado_vivienda (vivienda_id, armado) VALUES ('casa-001', true)
                    ON CONFLICT (vivienda_id) DO UPDATE SET armado = true`);
    const reg = await fetch(`${base}/auth/registro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dueno@ejemplo.com', nombre: 'Dueno', clave: 'clave-segura-123' })
    });
    assert.equal(reg.status < 300, true, `registro: ${await reg.text()}`);
    const ent = await fetch(`${base}/auth/entrar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dueno@ejemplo.com', clave: 'clave-segura-123' })
    });
    assert.equal(ent.status, 200);
    const cookie = (ent.headers.getSetCookie ? ent.headers.getSetCookie() : [ent.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
    const api = (ruta) => fetch(`${base}${ruta}`, { headers: { cookie } }).then((r) => r.json());

    // El servicio ONVIF se conecta y queda en estado conocido, sin alertas
    assert.ok(await hasta(async () => (await api('/camara/deteccion?vivienda_id=casa-001')).persona === false), `la deteccion no quedo activa:\n${salida.slice(-1500)}`);
    const det0 = await api('/camara/deteccion?vivienda_id=casa-001');
    assert.equal(det0.conectado, true);
    assert.equal((await db.query('SELECT 1 FROM eventos_camara')).rows.length, 0, 'la sincronizacion inicial no debe generar eventos');

    // El agente de la camara (ffmpeg con una fuente de prueba en lugar de RTSP)
    const alcance = net.createServer((c) => c.destroy());
    await new Promise((r) => alcance.listen(0, '127.0.0.1', r));
    t.after(() => alcance.close());
    agente = new AgenteCamara({
      ...leerConfig({}), viviendaId: 'casa-001', camaraId: 'mc210', token: 'token-global', baseUrl: base,
      host: '127.0.0.1', puerto: alcance.address().port, usuario: 'u', clave: 'c', esperaS: 2,
      entrada: () => ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10']
    }, () => {});
    agente.iniciar();
    assert.ok(await hasta(async () => (await db.query('SELECT 1 FROM camaras WHERE camara_id = $1', ['mc210'])).rows.length === 1),
      'la camara no figura en linea');

    // --- Entra una persona
    await esperarMs(1600);
    camaraOnvif.emitir({ tipo: 'persona', valor: true });

    assert.ok(await hasta(async () => (await db.query(`SELECT 1 FROM fotos WHERE vivienda_id = 'casa-001'`)).rows.length === 3, 25000),
      `no se guardaron las 3 fotos:\n${salida.slice(-2000)}`);

    const ev = (await db.query('SELECT detector, valor, transicion, alerta FROM eventos_camara ORDER BY id')).rows;
    assert.deepEqual(ev.map((e) => `${e.detector}:${e.transicion}`), ['persona:subida']);
    assert.equal(ev[0].alerta, true);

    // El servidor guarda la foto y despues actualiza el contador de la tarea: se espera a que termine
    assert.ok(await hasta(async () => (await db.query('SELECT 1 FROM tareas_camara WHERE terminada_en IS NOT NULL')).rows.length === 1));
    const tarea = (await db.query('SELECT tipo, usuario, tomadas, terminada_en FROM tareas_camara ORDER BY id')).rows;
    assert.equal(tarea.length, 1);
    assert.equal(tarea[0].usuario, 'evento');
    assert.equal(tarea[0].tomadas, 3);
    assert.ok(tarea[0].terminada_en);

    const fotos = (await db.query('SELECT id, bytes FROM fotos ORDER BY id')).rows;
    for (const f of fotos) {
      const ruta = path.join(dirFotos, String(Math.floor(f.id / 1000)), `${f.id}.jpg`);
      const b = fs.readFileSync(ruta);
      assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8);
      assert.equal(b.length, f.bytes);
    }

    // --- La API las muestra a la persona autenticada
    const lista = await api('/fotos?vivienda_id=casa-001');
    assert.equal(lista.total, 3);
    const eventos = await api('/camara/eventos?vivienda_id=casa-001');
    assert.equal(eventos.ok, true);
    assert.equal(eventos.eventos[0].detector, 'persona');
    const imagen = await fetch(`${base}/fotos/${fotos[0].id}/imagen`, { headers: { cookie } });
    assert.equal(imagen.status, 200);
    assert.equal(imagen.headers.get('content-type'), 'image/jpeg');
    // Sin sesion no se ve nada
    assert.equal((await fetch(`${base}/camara/eventos?vivienda_id=casa-001`)).status, 401);

    // --- La alarma NO se toco
    const est = (await db.query(`SELECT * FROM estado_vivienda WHERE vivienda_id = 'casa-001'`)).rows[0];
    assert.equal(est.alarma_activa, false);
    assert.equal(est.actuador_activo, false);
    assert.equal((await db.query(`SELECT 1 FROM acciones WHERE accion LIKE 'alarma%'`)).rows.length, 0);

    // --- La persona sale: evento de bajada, sin nueva alerta ni fotos extra
    camaraOnvif.emitir({ tipo: 'persona', valor: false });
    assert.ok(await hasta(async () => (await db.query(`SELECT 1 FROM eventos_camara WHERE transicion = 'bajada'`)).rows.length === 1));
    await esperarMs(1500);
    assert.equal((await db.query('SELECT 1 FROM fotos')).rows.length, 3);
    assert.equal((await db.query('SELECT 1 FROM tareas_camara')).rows.length, 1);
  } catch (e) {
    e.message += `\n--- Salida del servidor ---\n${salida.slice(-2500)}`;
    throw e;
  }
});
