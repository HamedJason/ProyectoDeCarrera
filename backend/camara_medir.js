#!/usr/bin/env node
/*
 * Mide cuantos cuadros por segundo da de verdad el flujo de la camara por el tunel, con el mismo
 * ffmpeg y los mismos parametros que la vista en vivo, pero sin enviar nada al servidor.
 * Sirve para elegir CAMARA_VIVO_FPS con datos en lugar de a ojo.
 *
 * Uso (en el VPS, dentro del contenedor, que ya tiene el usuario y la clave de la camara):
 *   docker exec alarma_backend node camara_medir.js            # 10 s por prueba, stream2
 *   docker exec alarma_backend node camara_medir.js 15 stream1 # 15 s por prueba, otro flujo
 *   docker exec alarma_backend node camara_medir.js 10 stream2 960   # con otro ancho (por omision 640)
 *
 * Para cada valor de fps muestra los cuadros que salen realmente por segundo, el tamano de cada
 * cuadro y el caudal que habria hacia el telefono. Primero mide el maximo del flujo sin limite.
 *
 * No abre mas flujos que los suyos, pero tampoco conviene correrlo con una vista en vivo abierta.
 */

const { spawn } = require('child_process');
const { leerConfig, entradaRtsp, alcanzable } = require('./camara_rtsp');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Una prueba: ffmpeg durante "segundos" (sin contar la conexion), con el limite de fps indicado
 * (fps = 0: sin limite, para ver lo que da el flujo). Devuelve las cifras medidas.
 */
function medirUna(cfg, { fps = 0, segundos = 10, ruta = cfg.rutaVivo, ancho = cfg.vivoAncho, entrada = null } = {}) {
  return new Promise((resolver) => {
    const filtro = `${fps > 0 ? `fps=${fps},` : ''}scale=${ancho}:-2`;
    const entradaArgs = entrada ? entrada(ruta) : entradaRtsp(cfg, ruta);
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'info', ...entradaArgs, '-an', '-vf', filtro, '-q:v', '6', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
    const p = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let resto = Buffer.alloc(0), err = '';
    const r = { fps, ancho, cuadros: 0, bytes: 0, maxBytes: 0, sobreLimite: 0, primero: 0, ultimo: 0, origen: null, error: null };
    const terminar = () => {
      clearTimeout(reloj);
      const dur = r.cuadros > 1 ? (r.ultimo - r.primero) / 1000 : 0;
      r.fpsReales = dur > 0 ? (r.cuadros - 1) / dur : 0;
      r.kbPorCuadro = r.cuadros ? r.bytes / r.cuadros / 1024 : 0;
      r.kbPorSegundo = dur > 0 ? r.bytes / dur / 1024 : 0;
      const m = err.match(/Stream #\d+:\d+.*?Video: ([^\n]*)/);
      if (m) {
        const res = m[1].match(/(\d{3,5}x\d{3,5})/);
        const fr = m[1].match(/([\d.]+) fps/);
        r.origen = `${res ? res[1] : '?'}${fr ? ` a ${fr[1]} fps anunciados` : ''}`;
      }
      if (!r.cuadros) r.error = (err.trim().split('\n').pop() || 'ffmpeg no entrego ningun cuadro').replace(new RegExp(cfg.clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
      resolver(r);
    };
    // El tiempo cuenta desde el primer cuadro: conectarse a la camara tarda y no es parte del caudal
    let reloj = setTimeout(() => p.kill('SIGKILL'), (segundos + 25) * 1000);
    p.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    p.stdout.on('data', (d) => {
      resto = Buffer.concat([resto, d]);
      let fin;
      while ((fin = resto.indexOf(EOI)) !== -1) {
        const jpg = resto.subarray(0, fin + 2);
        resto = resto.subarray(fin + 2);
        const ini = jpg.indexOf(SOI);
        if (ini === -1) continue;
        const tam = jpg.length - ini;
        const ahora = Date.now();
        if (!r.primero) {
          r.primero = ahora;
          clearTimeout(reloj);
          reloj = setTimeout(() => p.kill('SIGKILL'), segundos * 1000);
        }
        r.ultimo = ahora; r.cuadros++; r.bytes += tam;
        if (tam > r.maxBytes) r.maxBytes = tam;
        if (tam > cfg.cuadroMaxBytes) r.sobreLimite++;
      }
      if (resto.length > 4 * 1024 * 1024) resto = Buffer.alloc(0);
    });
    p.on('close', terminar);
    p.on('error', (e) => { err += e.message; terminar(); });
  });
}

/** Elige el valor mas alto probado que se cumple de verdad y con margen para el caudal. */
function recomendar(pruebas, maxKBs = 600) {
  const buenas = pruebas.filter((x) => x.fps > 0 && x.cuadros > 2 && x.fpsReales >= x.fps * 0.9 && x.sobreLimite === 0 && x.kbPorSegundo <= maxKBs);
  return buenas.length ? buenas[buenas.length - 1].fps : null;
}

async function principal() {
  const cfg = leerConfig();
  const segundos = Math.max(3, Number(process.argv[2]) || 10);
  const ruta = process.argv[3] || cfg.rutaVivo;
  const ancho = Number(process.argv[4]) || cfg.vivoAncho;
  if (!cfg.usuario || !cfg.clave) { console.error('Faltan RTSP_USUARIO/RTSP_CLAVE (o ONVIF_USUARIO/ONVIF_CLAVE) en el entorno.'); process.exit(2); }
  const entrada = cfg.fuentePrueba ? () => ['-re', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15'] : null;
  if (!entrada && !(await alcanzable(cfg.host, cfg.puerto))) { console.error(`No se alcanza ${cfg.host}:${cfg.puerto}. Revisa el tunel (verificar_puente.sh).`); process.exit(1); }

  console.log(`Camara ${cfg.host}:${cfg.puerto}, flujo "${ruta}", ancho ${ancho}, ${segundos} s por prueba. Mueve algo frente a la camara durante la medicion.\n`);
  const filas = [];
  const base = await medirUna(cfg, { fps: 0, segundos, ruta, ancho, entrada });
  if (base.error) { console.error(`No se pudo leer el flujo: ${base.error}`); process.exit(1); }
  console.log(`Flujo sin limite: ${base.origen || '(sin datos del flujo)'}; llegan ${base.fpsReales.toFixed(1)} cuadros/s por el tunel, ` +
    `${base.kbPorCuadro.toFixed(1)} KB por cuadro (maximo ${(base.maxBytes / 1024).toFixed(1)} KB).\n`);

  const objetivos = [4, 8, 10, 12, 15, 20, 25].filter((f) => f <= Math.ceil(base.fpsReales * 1.05));
  console.log('Objetivo | Reales | KB/cuadro | KB/s al telefono | Cuadros sobre el limite');
  console.log('---------+--------+-----------+------------------+------------------------');
  for (const f of objetivos) {
    const r = await medirUna(cfg, { fps: f, segundos, ruta, ancho, entrada });
    filas.push(r);
    console.log(`${String(f).padStart(5)} fps | ${r.fpsReales.toFixed(1).padStart(6)} | ${r.kbPorCuadro.toFixed(1).padStart(9)} | ${r.kbPorSegundo.toFixed(0).padStart(16)} | ${String(r.sobreLimite).padStart(10)}${r.error ? '  ' + r.error : ''}`);
  }
  const rec = recomendar(filas);
  console.log(`\nLimite de tamano por cuadro: ${Math.round(cfg.cuadroMaxBytes / 1024)} KB (CUADRO_MAX_KB). Un cuadro mas grande se descarta.`);
  if (rec) console.log(`Sugerencia: CAMARA_VIVO_FPS=${rec} en deploy/.env (el mayor que se cumple al 90 % y cabe en el limite).`);
  else console.log('Ninguno cumplio el 90 % con margen: queda el valor mas bajo, o prueba otro flujo/ancho.');
  console.log('Mira tambien el consumo del VPS durante una vista en vivo: docker stats alarma_backend');
}

if (require.main === module) {
  principal().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { medirUna, recomendar };
