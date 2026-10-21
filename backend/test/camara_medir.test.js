const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { medirUna, medirOrigen, recomendar } = require('../camara_medir');
const { leerConfig } = require('../camara_rtsp');

const hayFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const fuente = () => ['-re', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10'];
const cfg = { ...leerConfig({}), usuario: 'u', clave: 'secreta', host: '127.0.0.1' };

test('medirUna: sin limite mide lo que da el flujo y con limite respeta los fps pedidos', { skip: !hayFfmpeg }, async () => {
  const libre = await medirUna(cfg, { fps: 0, segundos: 3, entrada: fuente });
  assert.ok(libre.cuadros >= 20, `pocos cuadros: ${libre.cuadros}`);
  assert.ok(libre.fpsReales > 8 && libre.fpsReales < 13, `fps sin limite: ${libre.fpsReales}`);
  assert.match(libre.origen, /1280x720 a 10 fps/);
  assert.ok(libre.kbPorCuadro > 1 && libre.sobreLimite === 0);

  const limitado = await medirUna(cfg, { fps: 5, segundos: 3, entrada: fuente });
  assert.ok(limitado.fpsReales > 4 && limitado.fpsReales < 6.5, `fps con limite: ${limitado.fpsReales}`);
  assert.ok(limitado.kbPorSegundo < libre.kbPorSegundo, 'menos fps debe ser menos caudal');
});

test('medirUna: cuenta los cuadros que superan el limite de tamano', { skip: !hayFfmpeg }, async () => {
  const r = await medirUna({ ...cfg, cuadroMaxBytes: 500 }, { fps: 5, segundos: 2, entrada: fuente });
  assert.ok(r.cuadros > 3);
  assert.equal(r.sobreLimite, r.cuadros, 'todos superan 500 bytes');
});

test('medirUna: si ffmpeg no consigue leer, devuelve el error sin mostrar la clave', { skip: !hayFfmpeg }, async () => {
  const r = await medirUna(cfg, { fps: 0, segundos: 3, entrada: () => ['-i', 'rtsp://u:secreta@127.0.0.1:9/stream2'] });
  assert.equal(r.cuadros, 0);
  assert.ok(r.error);
  assert.ok(!r.error.includes('secreta'));
});

test('medirOrigen: mide los kbit/s que cruzan el tunel sin decodificar', { skip: !hayFfmpeg }, async () => {
  const os = require('os'), path = require('path'), fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-'));
  const mp4 = path.join(dir, 'v.mp4');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', mp4]);
  } catch (e) { return; }   // sin libx264 no hay con que probar
  const r = await medirOrigen(cfg, { segundos: 3, entrada: () => ['-re', '-stream_loop', '-1', '-i', mp4] });
  assert.ok(!r.error, r.error);
  assert.ok(r.kbitPromedio > 0 && r.kbitMaximo >= r.kbitPromedio && r.kbitMinimo <= r.kbitPromedio);
  const malo = await medirOrigen(cfg, { segundos: 3, entrada: () => ['-i', 'rtsp://u:secreta@127.0.0.1:9/stream2'] });
  assert.ok(malo.error && !malo.error.includes('secreta'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recomendar: el mayor fps que se cumple al 90 %, sin pasar el limite de tamano ni el caudal', () => {
  const p = [
    { fps: 4, cuadros: 40, fpsReales: 4, sobreLimite: 0, kbPorSegundo: 100 },
    { fps: 10, cuadros: 100, fpsReales: 9.8, sobreLimite: 0, kbPorSegundo: 250 },
    { fps: 15, cuadros: 100, fpsReales: 9.1, sobreLimite: 0, kbPorSegundo: 250 },      // no llega: el tunel no da mas
    { fps: 20, cuadros: 100, fpsReales: 20, sobreLimite: 3, kbPorSegundo: 400 },       // cuadros demasiado grandes
    { fps: 25, cuadros: 100, fpsReales: 31, sobreLimite: 0, kbPorSegundo: 400 }        // cuadros duplicados: no es real
  ];
  assert.equal(recomendar(p), 10);
  assert.equal(recomendar([{ fps: 25, cuadros: 100, fpsReales: 25, sobreLimite: 0, kbPorSegundo: 900 }]), null);
  assert.equal(recomendar([]), null);
});

test('la vista en vivo sale a 10 fps por omision (configurable con CAMARA_VIVO_FPS)', () => {
  assert.equal(leerConfig({}).vivoFps, 10);
  assert.equal(leerConfig({ CAMARA_VIVO_FPS: '15' }).vivoFps, 15);
  assert.equal(leerConfig({ CAMARA_VIVO_FPS: '0' }).vivoFps, 10);
});
