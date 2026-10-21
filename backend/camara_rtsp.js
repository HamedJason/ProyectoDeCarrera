/*
 * Agente de la camara MC210 (RTSP bajo demanda).
 *
 * El backend ya tiene un protocolo para camaras (camara.js): la camara pregunta
 * si hay tareas y responde con fotos o cuadros de video. Este modulo hace ese
 * papel para la MC210, que no lo habla por si sola: pregunta al propio backend
 * (por 127.0.0.1, con el token del dispositivo) y, cuando hay una tarea, le
 * pide el video a la camara con ffmpeg.
 *
 *   foto  -> un cuadro por cada foto pedida (ffmpeg corre un segundo y termina)
 *   vivo  -> cuadros JPEG continuos hasta que el servidor diga que pare
 *
 * RTSP NUNCA queda abierto: ffmpeg solo existe mientras dura una tarea. Mientras
 * no hay tareas lo unico que se hace es preguntar cada ~20 s y comprobar con una
 * conexion TCP corta que la camara responde, para no figurar "en linea" si esta
 * apagada. Esa presencia es la que usa el backend para decidir si pide fotos.
 *
 * Se reutiliza el protocolo y no la logica interna para conservar, sin
 * duplicarlos, los topes de espacio, las cuotas de vista en vivo y la
 * autenticacion del dispositivo.
 */

const net = require('net');
const { spawn } = require('child_process');

const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

function leerConfig(env = process.env) {
  return {
    activo: env.CAMARA_RTSP_ACTIVO === '1' || env.CAMARA_RTSP_ACTIVO === 'true',
    viviendaId: env.CAMARA_VIVIENDA_ID || env.ONVIF_VIVIENDA_ID || '',
    camaraId: env.CAMARA_ID || env.ONVIF_CAMARA_ID || 'mc210',
    // El mismo token que usa el concentrador de esa vivienda (el global DEVICE_TOKEN si no tiene uno propio)
    token: env.CAMARA_TOKEN || env.DEVICE_TOKEN || '',
    baseUrl: env.CAMARA_BACKEND_URL || `http://127.0.0.1:${env.PORT || 3000}`,
    host: env.RTSP_HOST || env.ONVIF_HOST || '10.8.0.2',
    puerto: num(env.RTSP_PUERTO, 554),
    usuario: env.RTSP_USUARIO || env.ONVIF_USUARIO || '',
    clave: env.RTSP_CLAVE || env.ONVIF_CLAVE || '',
    rutaFoto: env.RTSP_RUTA_FOTO || 'stream1',   // mejor calidad: se pide solo un cuadro
    rutaVivo: env.RTSP_RUTA_VIVO || 'stream2',   // menor calidad: es un flujo continuo
    vivoFps: num(env.CAMARA_VIVO_FPS, 4),
    vivoAncho: num(env.CAMARA_VIVO_ANCHO, 640),
    fotoMaxBytes: num(env.FOTO_MAX_KB, 1024) * 1024,
    cuadroMaxBytes: num(env.CUADRO_MAX_KB, 150) * 1024,
    esperaS: num(env.CAMARA_ESPERA_S, 20),
    ffmpeg: env.FFMPEG_BIN || 'ffmpeg'
  };
}

const esperar = (ms, senal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  if (senal) senal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/** Conexion TCP corta al puerto RTSP. No abre ningun flujo de video. */
function alcanzable(host, puerto, ms = 3000) {
  return new Promise((res) => {
    const s = net.connect({ host, port: puerto });
    const fin = (ok) => { s.destroy(); res(ok); };
    s.setTimeout(ms, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

/** Argumentos de entrada de ffmpeg para una ruta RTSP. Las pruebas lo sustituyen por una fuente local. */
function entradaRtsp(cfg, ruta) {
  const u = encodeURIComponent(cfg.usuario), c = encodeURIComponent(cfg.clave);
  return ['-rtsp_transport', 'tcp', '-i', `rtsp://${u}:${c}@${cfg.host}:${cfg.puerto}/${ruta}`];
}

/** Oculta la clave en cualquier texto que salga de ffmpeg. */
function ocultar(cfg, texto) {
  let t = String(texto);
  for (const s of [cfg.clave, encodeURIComponent(cfg.clave)]) if (s && s.length >= 3) t = t.split(s).join('***');
  return t;
}

class AgenteCamara {
  /** @param {object} cfg ver leerConfig; cfg.entrada(ruta) y cfg.fetch pueden sustituirse en pruebas */
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.entrada = cfg.entrada || ((ruta) => entradaRtsp(cfg, ruta));
    this._fetch = cfg.fetch || fetch;
    this.parar = new AbortController();
    this.estadisticas = { fotos: 0, cuadros: 0, tareas: 0, errores: 0, ffmpegLanzados: 0 };
    this.procesoActual = null;
  }

  iniciar() {
    this._lazo = this._lazoPrincipal().catch((e) => this.log('error', `El agente de la camara termino: ${e.message}`));
  }

  async detener() {
    this.parar.abort();
    if (this.procesoActual) { try { this.procesoActual.kill('SIGKILL'); } catch (e) { /* ya termino */ } }
    if (this._lazo) await this._lazo;
  }

  _cabeceras(extra = {}) { return { 'X-Device-Token': this.cfg.token, ...extra }; }
  _consulta() { return `vivienda_id=${encodeURIComponent(this.cfg.viviendaId)}&camara_id=${encodeURIComponent(this.cfg.camaraId)}`; }

  async _lazoPrincipal() {
    while (!this.parar.signal.aborted) {
      // Si la camara no responde no se le pregunta nada al backend: asi deja de figurar en linea
      if (!(await alcanzable(this.cfg.host, this.cfg.puerto))) {
        await esperar(10000, this.parar.signal);
        continue;
      }
      let tarea = null;
      try {
        const r = await this._fetch(`${this.cfg.baseUrl}/camara/tarea?${this._consulta()}&espera=${this.cfg.esperaS}`, {
          headers: this._cabeceras(), signal: AbortSignal.timeout((this.cfg.esperaS + 15) * 1000)
        });
        if (r.status === 401 || r.status === 403) {
          this.log('error', 'El backend rechazo el token de la camara (CAMARA_TOKEN / DEVICE_TOKEN).');
          await esperar(30000, this.parar.signal);
          continue;
        }
        const j = await r.json();
        tarea = j && j.tarea;
      } catch (e) {
        if (this.parar.signal.aborted) break;
        this.estadisticas.errores++;
        this.log('aviso', `No se pudo consultar tareas: ${e.message}`);
        await esperar(5000, this.parar.signal);
        continue;
      }
      if (!tarea) continue;
      this.estadisticas.tareas++;
      try {
        if (tarea.tipo === 'foto') await this.hacerFotos(tarea);
        else if (tarea.tipo === 'vivo') await this.hacerVivo(tarea);
      } catch (e) {
        if (this.parar.signal.aborted) break;
        this.estadisticas.errores++;
        this.log('aviso', `Tarea ${tarea.id} (${tarea.tipo}) fallo: ${e.message}`);
        await esperar(3000, this.parar.signal);
      }
    }
  }

  // ---------- Fotos ----------

  /** Un cuadro JPEG de la camara. ffmpeg se lanza, saca un cuadro y termina. */
  capturarJpeg(ruta) {
    const args = ['-nostdin', '-loglevel', 'error', ...this.entrada(ruta), '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
    return new Promise((res, rej) => {
      this.estadisticas.ffmpegLanzados++;
      const p = spawn(this.cfg.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.procesoActual = p;
      const trozos = []; let bytes = 0, err = '';
      const limite = setTimeout(() => p.kill('SIGKILL'), 20000);
      p.stdout.on('data', (d) => { bytes += d.length; if (bytes <= this.cfg.fotoMaxBytes) trozos.push(d); });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(limite); rej(new Error(`no se pudo ejecutar ffmpeg: ${e.message}`)); });
      p.on('close', () => {
        clearTimeout(limite);
        this.procesoActual = null;
        const jpg = Buffer.concat(trozos);
        if (bytes > this.cfg.fotoMaxBytes) return rej(new Error('la imagen supera el tamano maximo'));
        if (jpg.length < 5 || jpg[0] !== 0xff || jpg[1] !== 0xd8) return rej(new Error(`ffmpeg no entrego una imagen: ${ocultar(this.cfg, err).trim().split('\n').pop()}`));
        res(jpg);
      });
    });
  }

  async hacerFotos(tarea) {
    let restantes = tarea.restantes || 1;
    while (restantes > 0 && !this.parar.signal.aborted) {
      const jpg = await this.capturarJpeg(this.cfg.rutaFoto);
      const r = await this._fetch(`${this.cfg.baseUrl}/camara/foto?tarea=${tarea.id}&${this._consulta()}`, {
        method: 'POST', headers: this._cabeceras({ 'Content-Type': 'image/jpeg' }), body: jpg, signal: AbortSignal.timeout(20000)
      });
      if (r.status !== 201) {
        // 409: la tarea ya termino. 507: el servidor casi no tiene espacio.
        this.log('aviso', `El backend no acepto la foto (codigo ${r.status}); se detiene la tarea.`);
        return;
      }
      this.estadisticas.fotos++;
      const j = await r.json();
      restantes = j.restantes;
      if (restantes > 0) await esperar(tarea.intervalo_ms || 700, this.parar.signal);
    }
  }

  // ---------- Vista en vivo ----------

  async hacerVivo(tarea) {
    const cfg = this.cfg;
    const args = ['-nostdin', '-loglevel', 'error', ...this.entrada(cfg.rutaVivo), '-an',
      '-vf', `fps=${cfg.vivoFps},scale=${cfg.vivoAncho}:-2`, '-q:v', '6', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
    this.estadisticas.ffmpegLanzados++;
    const p = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.procesoActual = p;
    let err = '';
    p.stderr.on('data', (d) => { err += d; });

    let continuar = true, enVuelo = false, resto = Buffer.alloc(0);
    const limite = setTimeout(() => { continuar = false; p.kill('SIGKILL'); }, ((tarea.restante_s || 300) + 10) * 1000);
    const alAbortar = () => { continuar = false; p.kill('SIGKILL'); };
    this.parar.signal.addEventListener('abort', alAbortar, { once: true });

    const enviar = async (jpg) => {
      enVuelo = true;
      try {
        const r = await this._fetch(`${cfg.baseUrl}/camara/cuadro?tarea=${tarea.id}&vivienda_id=${encodeURIComponent(cfg.viviendaId)}`, {
          method: 'POST', headers: this._cabeceras({ 'Content-Type': 'image/jpeg' }), body: jpg, signal: AbortSignal.timeout(8000)
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 200 && j.continuar === false) { continuar = false; p.kill('SIGKILL'); }
        else if (r.status === 200) this.estadisticas.cuadros++;
      } catch (e) { /* un cuadro perdido no detiene la sesion */ } finally { enVuelo = false; }
    };

    await new Promise((res) => {
      p.stdout.on('data', (d) => {
        resto = Buffer.concat([resto, d]);
        // Un JPEG empieza con FF D8 y termina con FF D9 (en los datos, FF va siempre seguido de 00)
        let fin;
        while ((fin = resto.indexOf(Buffer.from([0xff, 0xd9]))) !== -1) {
          const jpg = resto.subarray(0, fin + 2);
          resto = resto.subarray(fin + 2);
          const inicio = jpg.indexOf(Buffer.from([0xff, 0xd8]));
          if (inicio === -1 || !continuar) continue;
          const cuadro = jpg.subarray(inicio);
          // Si el cuadro anterior sigue enviandose, este se salta en vez de acumular
          if (!enVuelo && cuadro.length <= cfg.cuadroMaxBytes) enviar(cuadro);
        }
        if (resto.length > cfg.cuadroMaxBytes * 4) resto = Buffer.alloc(0);   // proteccion ante datos sin forma
      });
      p.on('close', res);
      p.on('error', res);
    });
    clearTimeout(limite);
    this.parar.signal.removeEventListener('abort', alAbortar);
    this.procesoActual = null;
    if (continuar && !this.parar.signal.aborted && err.trim()) {
      throw new Error(`ffmpeg termino antes de lo esperado: ${ocultar(cfg, err).trim().split('\n').pop()}`);
    }
  }
}

/** Arranca el agente si esta activado. Se llama cuando el backend ya escucha. */
function iniciar(config = leerConfig()) {
  if (!config.activo) { console.log('Agente de camara RTSP desactivado (CAMARA_RTSP_ACTIVO no es 1).'); return null; }
  const faltan = [['viviendaId', 'CAMARA_VIVIENDA_ID u ONVIF_VIVIENDA_ID'], ['token', 'CAMARA_TOKEN o DEVICE_TOKEN'],
    ['usuario', 'RTSP_USUARIO u ONVIF_USUARIO'], ['clave', 'RTSP_CLAVE u ONVIF_CLAVE']].filter(([k]) => !config[k]).map(([, n]) => n);
  if (faltan.length) { console.warn(`Agente de camara RTSP activado pero faltan: ${faltan.join(', ')}. No se inicia.`); return null; }
  const agente = new AgenteCamara(config, (nivel, msg) => (nivel === 'error' ? console.error : console.warn)(`[camara] ${msg}`));
  agente.iniciar();
  console.log(`Agente de camara activo: "${config.camaraId}" en ${config.host}:${config.puerto} (RTSP solo bajo demanda).`);
  return agente;
}

module.exports = { AgenteCamara, leerConfig, iniciar, alcanzable, entradaRtsp };
