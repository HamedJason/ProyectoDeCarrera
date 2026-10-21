const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const { getEventListeners } = require('events');
const { AgenteCamara, leerConfig, esperar: esperarAgente } = require('../camara_rtsp');
const { esperar: esperarOnvif } = require('../onvif/servicio');
const { iniciarCamaraFalsa } = require('./camara_onvif_falsa');
const { MotorEventos } = require('../onvif/estados');
const { ServicioOnvif } = require('../onvif/servicio');

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 6000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperarMs(25); }
  return false;
}
const hayFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const esJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

// Backend de mentira con el protocolo de camara.js
async function backendFalso({ token = 'tok' } = {}) {
  const s = { tareas: [], consultas: 0, fotos: [], cuadros: [], restantes: new Map(), cortarVivoTras: Infinity, tokensMalos: 0, ultimaTarea: null };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let trozos = [];
    req.on('data', (d) => trozos.push(d));
    req.on('end', () => {
      const cuerpo = Buffer.concat(trozos);
      if (req.headers['x-device-token'] !== token) { s.tokensMalos++; res.writeHead(401); return res.end('{}'); }
      const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.pathname === '/camara/tarea') {
        s.consultas++;
        const t = s.tareas.shift();
        if (t) { s.ultimaTarea = t; s.restantes.set(t.id, t.restantes); return json(200, { ok: true, tarea: t }); }
        return setTimeout(() => json(200, { ok: true, tarea: null }), 200);
      }
      if (url.pathname === '/camara/foto') {
        const id = Number(url.searchParams.get('tarea'));
        if (!s.restantes.has(id) || s.restantes.get(id) <= 0) return json(409, { ok: false });
        s.fotos.push(cuerpo);
        s.restantes.set(id, s.restantes.get(id) - 1);
        return json(201, { ok: true, restantes: s.restantes.get(id) });
      }
      if (url.pathname === '/camara/cuadro') {
        s.cuadros.push(cuerpo);
        return json(200, { ok: true, continuar: s.cuadros.length < s.cortarVivoTras });
      }
      return json(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${srv.address().port}`;
  s.cerrar = () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  return s;
}

// "Camara" TCP que solo acepta conexiones, para que la comprobacion de alcance pase
async function puertoFalso() {
  const srv = net.createServer((c) => c.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { puerto: srv.address().port, cerrar: () => new Promise((r) => srv.close(r)) };
}

function agente(backend, puerto, extra = {}) {
  const rutas = [];
  const cfg = {
    ...leerConfig({}), viviendaId: 'casa-001', camaraId: 'mc210', token: 'tok', baseUrl: backend.url,
    host: '127.0.0.1', puerto, usuario: 'u', clave: 'c', esperaS: 1, vivoFps: 8, vivoAncho: 320,
    // En lugar de RTSP, ffmpeg lee una imagen de prueba generada en el momento
    entrada: (ruta) => { rutas.push(ruta); return ['-re', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10']; },
    ...extra
  };
  const a = new AgenteCamara(cfg, () => {});
  a.rutas = rutas;
  return a;
}

test('foto: pide un cuadro por foto a ffmpeg, usa el flujo de foto y no deja procesos abiertos', { skip: !hayFfmpeg }, async () => {
  const b = await backendFalso(); const cam = await puertoFalso();
  const a = agente(b, cam.puerto);
  try {
    b.tareas.push({ id: 1, tipo: 'foto', restantes: 3, intervalo_ms: 50 });
    a.iniciar();
    assert.ok(await hasta(() => b.fotos.length === 3), 'no llegaron las 3 fotos');
    assert.ok(b.fotos.every(esJpeg));
    assert.ok(b.fotos.every((f) => f.length < 1024 * 1024));
    assert.equal(a.estadisticas.ffmpegLanzados, 3);
    assert.deepEqual([...new Set(a.rutas)], ['stream1']);
    assert.equal(a.procesoActual, null);
  } finally { await a.detener(); await b.cerrar(); await cam.cerrar(); }
});

test('vivo: manda cuadros JPEG de stream2 hasta que el servidor dice que pare y entonces cierra ffmpeg', { skip: !hayFfmpeg }, async () => {
  const b = await backendFalso(); const cam = await puertoFalso();
  b.cortarVivoTras = 6;
  const a = agente(b, cam.puerto);
  try {
    b.tareas.push({ id: 2, tipo: 'vivo', restante_s: 30 });
    a.iniciar();
    assert.ok(await hasta(() => b.cuadros.length >= 6), 'no llegaron los cuadros');
    assert.ok(b.cuadros.every(esJpeg), 'algun cuadro no es un JPEG completo');
    assert.ok(b.cuadros.every((c) => c.length <= 150 * 1024));
    assert.deepEqual([...new Set(a.rutas)], ['stream2']);
    // Tras la orden de parar, el agente cierra ffmpeg y vuelve a preguntar por tareas
    const consultas = b.consultas;
    assert.ok(await hasta(() => a.procesoActual === null && b.consultas > consultas, 5000), 'no volvio a preguntar');
  } finally { await a.detener(); await b.cerrar(); await cam.cerrar(); }
});

test('sin tareas no se lanza ffmpeg: RTSP no queda abierto mientras la camara esta en reposo', { skip: !hayFfmpeg }, async () => {
  const b = await backendFalso(); const cam = await puertoFalso();
  const a = agente(b, cam.puerto);
  try {
    a.iniciar();
    assert.ok(await hasta(() => b.consultas >= 3));
    assert.equal(a.estadisticas.ffmpegLanzados, 0);
    assert.equal(a.procesoActual, null);
  } finally { await a.detener(); await b.cerrar(); await cam.cerrar(); }
});

test('si la camara no responde, no se consulta al backend (asi deja de figurar en linea)', async () => {
  const b = await backendFalso(); const cam = await puertoFalso();
  const puerto = cam.puerto;
  await cam.cerrar();                      // el puerto ya no escucha
  const a = agente(b, puerto);
  try {
    a.iniciar();
    await esperarMs(800);
    assert.equal(b.consultas, 0);
    const t0 = Date.now();
    await a.detener();                     // debe salir sin esperar los 10 s de la pausa
    assert.ok(Date.now() - t0 < 2000);
  } finally { await b.cerrar(); }
});

test('token incorrecto: no procesa tareas ni lanza ffmpeg', async () => {
  const b = await backendFalso({ token: 'otro' }); const cam = await puertoFalso();
  const a = agente(b, cam.puerto);
  try {
    b.tareas.push({ id: 3, tipo: 'foto', restantes: 1 });
    a.iniciar();
    assert.ok(await hasta(() => b.tokensMalos >= 1));
    assert.equal(a.estadisticas.ffmpegLanzados, 0);
    assert.equal(b.fotos.length, 0);
  } finally { await a.detener(); await b.cerrar(); await cam.cerrar(); }
});

test('los eventos ONVIF siguen llegando mientras hay una sesion de video bajo demanda', { skip: !hayFfmpeg }, async () => {
  const b = await backendFalso(); const cam = await puertoFalso();
  b.cortarVivoTras = 40;
  const camaraOnvif = await iniciarCamaraFalsa();
  const alertas = [];
  const motor = new MotorEventos({ ventanaSyncMs: 1500, dedupMs: 300, alAlerta: (x) => alertas.push(x) });
  const servicio = new ServicioOnvif({
    camaraId: 'c1', host: '127.0.0.1', puerto: camaraOnvif.puerto, usuario: camaraOnvif.usuario, clave: camaraOnvif.clave,
    suscripcionS: 2, esperaS: 1
  }, { motor });
  const a = agente(b, cam.puerto);
  try {
    servicio.iniciar();
    assert.ok(await hasta(() => motor.estado('c1').persona === false));
    await esperarMs(1600);
    b.tareas.push({ id: 4, tipo: 'vivo', restante_s: 30 });
    a.iniciar();
    assert.ok(await hasta(() => b.cuadros.length >= 3), 'el video no arranco');
    camaraOnvif.emitir({ tipo: 'persona', valor: true });
    assert.ok(await hasta(() => alertas.length === 1), 'el evento no llego durante el video');
    const antes = b.cuadros.length;
    assert.ok(await hasta(() => b.cuadros.length > antes), 'el video se detuvo al llegar el evento');
    assert.equal(servicio.estado().conexiones, 1);   // sin reconexiones por el video
  } finally { await servicio.detener(); await a.detener(); await camaraOnvif.cerrar(); await b.cerrar(); await cam.cerrar(); }
});

test('esperar no deja listeners pegados a la senal (evita MaxListenersExceededWarning en servicios de larga vida)', async () => {
  for (const esperar of [esperarAgente, esperarOnvif]) {
    const control = new AbortController();
    for (let i = 0; i < 30; i++) await esperar(1, control.signal);
    assert.equal(getEventListeners(control.signal, 'abort').length, 0);
    // Y sigue respondiendo al aborto: sale al instante en vez de esperar todo el tiempo
    const t0 = Date.now();
    const p = esperar(5000, control.signal);
    control.abort();
    await p;
    assert.ok(Date.now() - t0 < 500);
    assert.equal(getEventListeners(control.signal, 'abort').length, 0);
    // Con la senal ya abortada tampoco espera
    const t1 = Date.now();
    await esperar(5000, control.signal);
    assert.ok(Date.now() - t1 < 500);
  }
});
