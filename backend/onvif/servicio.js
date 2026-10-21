/*
 * Servicio ONVIF de una camara.
 *
 * Mantiene una suscripcion PullPoint abierta, recibe los mensajes con long
 * polling y se los pasa al motor de estados. Se encarga de:
 *   - renovar la suscripcion antes de que expire (mitad de su duracion);
 *   - recuperarse solo de cualquier error, con esperas crecientes;
 *   - avisar al motor cuando se pierde o se recupera la conexion;
 *   - no abrir nunca el video: solo usa el puerto ONVIF.
 *
 * Un solo bucle por camara: nunca hay dos PullMessages a la vez.
 */

const { ClienteOnvif, ErrorOnvif } = require('./cliente');

const TOPICS_ESPERADOS = ['RuleEngine/PeopleDetector/People', 'RuleEngine/CellMotionDetector/Motion'];

const esperar = (ms, senal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  if (senal) senal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

class ServicioOnvif {
  /**
   * @param {object} cfg
   *   camaraId, host, puerto, usuario, clave,
   *   suscripcionS (duracion de la suscripcion), esperaS (long polling),
   *   esperaMinReconexionMs, esperaMaxReconexionMs, registroXml, cliente (para pruebas)
   * @param {object} deps { motor, log, ahora }
   */
  constructor(cfg, deps) {
    this.cfg = {
      suscripcionS: 60, esperaS: 20, esperaMinReconexionMs: 1000, esperaMaxReconexionMs: 30000, ...cfg
    };
    this.motor = deps.motor;
    this.log = deps.log || (() => {});
    this.ahora = deps.ahora || Date.now;
    this.cliente = cfg.cliente || new ClienteOnvif({
      host: cfg.host, puerto: cfg.puerto, usuario: cfg.usuario, clave: cfg.clave, registroXml: cfg.registroXml
    });
    this.parar = new AbortController();
    this.corriendo = false;
    this.estadoInfo = {
      conectado: false, ultimaConexionMs: null, ultimoMensajeMs: null, ultimoErrorMs: null, ultimoError: null,
      conexiones: 0, renovaciones: 0, cortesRecuperados: 0, esperasVencidas: 0, errores: 0, mensajes: 0, topicsCamara: [], faltanTopics: []
    };
  }

  estado() { return { ...this.estadoInfo, camaraId: this.cfg.camaraId, motor: this.motor.estado(this.cfg.camaraId) }; }

  iniciar() {
    if (this.corriendo) return;
    this.corriendo = true;
    this._ticker = setInterval(() => { try { this.motor.tick(this.ahora()); } catch (e) { this.log('error', `tick: ${e.message}`); } }, 1000);
    this._ticker.unref();
    this._lazo = this._lazoPrincipal().catch((e) => this.log('error', `El servicio ONVIF termino por un error inesperado: ${e.message}`));
  }

  async detener() {
    this.parar.abort();
    clearInterval(this._ticker);
    if (this._lazo) await this._lazo;
    this.corriendo = false;
  }

  async _lazoPrincipal() {
    let espera = this.cfg.esperaMinReconexionMs;
    while (!this.parar.signal.aborted) {
      const inicio = this.ahora();
      let sus = null;
      try {
        sus = await this._conectar();
        await this._escuchar(sus);
      } catch (e) {
        if (this.parar.signal.aborted) break;
        this._registrarError(e);
      }
      if (sus) await this.cliente.cancelar(sus);
      if (this.estadoInfo.conectado) {
        this.estadoInfo.conectado = false;
        this.motor.desconectar(this.cfg.camaraId);
        if (!this.parar.signal.aborted) this.log('aviso', 'Conexion ONVIF perdida: el estado de la camara pasa a desconocido.');
      }
      if (this.parar.signal.aborted) break;
      // Si estuvo estable un buen rato, se empieza de nuevo con una espera corta
      if (this.ahora() - inicio > 30000) espera = this.cfg.esperaMinReconexionMs;
      this.log('info', `Reintentando la conexion ONVIF en ${Math.round(espera / 100) / 10} s.`);
      await esperar(espera, this.parar.signal);
      espera = Math.min(espera * 2, this.cfg.esperaMaxReconexionMs);
    }
  }

  async _conectar() {
    const c = this.cliente;
    await c.horaCamara();
    const ev = await c.direccionEventos();
    if (ev.original !== ev.url) this.log('info', `La camara anuncia su servicio de eventos en ${ev.original}; se usa ${ev.url}.`);

    try {
      const topics = await c.propiedadesEventos(ev.url, ev.original);
      this.estadoInfo.topicsCamara = topics;
      this.estadoInfo.faltanTopics = TOPICS_ESPERADOS.filter((t) => !topics.some((x) => x.endsWith(t)));
      if (this.estadoInfo.faltanTopics.length) {
        this.log('aviso', `La camara no anuncia estos topics esperados: ${this.estadoInfo.faltanTopics.join(', ')}. Anuncia: ${topics.join(', ') || '(ninguno)'}.`);
      } else {
        this.log('info', `Topics de la camara verificados: ${TOPICS_ESPERADOS.join(', ')}.`);
      }
    } catch (e) {
      // GetEventProperties es solo informativo: si falla, se intenta suscribir igual
      this.log('aviso', `No se pudieron leer los topics de la camara: ${e.message}`);
    }

    const sus = await c.crearSuscripcion(ev.url, ev.original, this.cfg.suscripcionS);
    sus.renovarEnMs = this.ahora() + (this.cfg.suscripcionS * 1000) / 2;
    this.estadoInfo.conectado = true;
    this.estadoInfo.conexiones++;
    this.estadoInfo.ultimaConexionMs = this.ahora();
    this.motor.conectar(this.cfg.camaraId, this.ahora());
    this.log('info', `Suscripcion ONVIF creada (${sus.url}).`);
    return sus;
  }

  async _escuchar(sus) {
    let cortes = 0;
    while (!this.parar.signal.aborted) {
      if (this.ahora() >= sus.renovarEnMs) {
        await this.cliente.renovar(sus, this.cfg.suscripcionS);
        sus.renovarEnMs = this.ahora() + (this.cfg.suscripcionS * 1000) / 2;
        this.estadoInfo.renovaciones++;
      }
      const t0 = this.ahora();
      let mensajes;
      try {
        mensajes = await this.cliente.extraer(sus, { esperaS: this.cfg.esperaS });
        cortes = 0;
      } catch (e) {
        // La camara a veces cierra el socket en mitad de una espera. La suscripcion sigue viva:
        // se repite la misma espera sin declarar la camara desconocida ni crear otra suscripcion.
        if (this.parar.signal.aborted) return;
        if (!(e instanceof ErrorOnvif && e.transitorio)) throw e;
        // La MC210 no contesta con una lista vacia cuando se agota la espera: cierra el socket.
        // Si el corte llega justo al vencer el tiempo pedido, es una espera vacia normal.
        if (this.ahora() - t0 >= this.cfg.esperaS * 1000 * 0.9) {
          this.estadoInfo.esperasVencidas++;
          cortes = 0;
          continue;
        }
        if (++cortes > 3) throw e;
        this.estadoInfo.cortesRecuperados++;
        this.log('info', `La camara cerro la conexion (${e.causa}); se repite la espera (${cortes}/3).`);
        await esperar(300, this.parar.signal);
        continue;
      }
      if (this.parar.signal.aborted) return;
      for (const m of mensajes) {
        this.estadoInfo.mensajes++;
        this.estadoInfo.ultimoMensajeMs = this.ahora();
        this.motor.procesar(this.cfg.camaraId, m, this.ahora());
      }
      // Hay camaras que ignoran el tiempo de espera y responden al instante: no se las satura
      if (!mensajes.length && this.ahora() - t0 < 300) await esperar(500, this.parar.signal);
    }
  }

  _registrarError(e) {
    this.estadoInfo.errores++;
    this.estadoInfo.ultimoErrorMs = this.ahora();
    this.estadoInfo.ultimoError = e.message;
    const tipo = e instanceof ErrorOnvif ? e.tipo : 'desconocido';
    const msg = `ONVIF (${tipo}): ${e.message}`;
    this.log(tipo === 'suscripcion_expirada' ? 'info' : 'aviso', msg);
  }
}

module.exports = { ServicioOnvif, TOPICS_ESPERADOS };
