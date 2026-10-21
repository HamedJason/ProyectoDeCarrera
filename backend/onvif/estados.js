/*
 * Motor de estados de los eventos ONVIF (personas y movimiento).
 *
 * Es logica pura: no abre conexiones, no usa base de datos ni temporizadores.
 * Recibe mensajes ya interpretados y el instante en que llegaron, y avisa por
 * funciones (callbacks) de tres cosas distintas:
 *
 *   alEvento       cada transicion REAL (false -> true o true -> false)
 *   alAlerta       cuando una subida merece avisar al residente
 *   alDiagnostico  todo lo que se descarta o se espera, para poder explicarlo
 *
 * Por que no se mira PropertyOperation:
 *   La MC210 manda siempre PropertyOperation="Initialized", aunque el valor
 *   cambie. Lo unico fiable es el valor (IsPeople / IsMotion), asi que aqui se
 *   comparan valores sucesivos de cada clave e ignora la operacion.
 *
 * Reglas (las numeradas vienen del requisito):
 *   - El estado es independiente por camara, detector y fuente/regla (6).
 *   - El primer mensaje de cada clave tras conectar o reconectar es una
 *     sincronizacion: se guarda, no genera evento ni alerta (7).
 *   - Solo cuenta un cambio de valor; un mensaje repetido se ignora (8, 9).
 *   - Entre alertas del mismo tipo hay un tiempo minimo, el cooldown (10).
 *   - Al perder la conexion el estado pasa a "desconocido", no a "sin personas" (11).
 *   - Una persona produce tambien IsMotion=true: solo se avisa una vez (12).
 *
 * Una precision sobre (7): solo se trata como sincronizacion el primer mensaje
 * que llega dentro de una ventana corta tras suscribirse (ventanaSyncMs). Si la
 * camara no manda estado inicial y la primera noticia de una clave llega mucho
 * despues con valor true, es una persona que acaba de entrar, y silenciarla
 * seria perder la alerta. Fuera de la ventana, un primer valor true cuenta como
 * subida; un primer valor false solo se anota.
 */

const DETECTORES = ['persona', 'movimiento'];

class MotorEventos {
  /**
   * @param {object} opc
   * @param {number} opc.cooldownPersonaMs     tiempo minimo entre alertas de persona
   * @param {number} opc.cooldownMovimientoMs  tiempo minimo entre alertas de movimiento
   * @param {number} opc.dedupMs               espera antes de alertar un movimiento, por si llega una persona
   * @param {number} opc.ventanaSyncMs         ventana en que el primer mensaje de una clave es sincronizacion
   * @param {function} opc.alEvento
   * @param {function} opc.alAlerta
   * @param {function} opc.alDiagnostico
   */
  constructor(opc = {}) {
    this.cooldownPersonaMs = opc.cooldownPersonaMs ?? 60000;
    this.cooldownMovimientoMs = opc.cooldownMovimientoMs ?? 120000;
    this.dedupMs = opc.dedupMs ?? 3000;
    this.ventanaSyncMs = opc.ventanaSyncMs ?? 5000;
    this.alEvento = opc.alEvento || (() => {});
    this.alAlerta = opc.alAlerta || (() => {});
    this.alDiagnostico = opc.alDiagnostico || (() => {});
    this.camaras = new Map();
  }

  _cam(camaraId) {
    let c = this.camaras.get(camaraId);
    if (!c) {
      c = {
        conectado: false,
        inicioSyncMs: 0,
        claves: new Map(),        // "detector|fuente|regla" -> { valor, desde }
        ultAlerta: { persona: -Infinity, movimiento: -Infinity },
        pendienteMov: null,       // { dueMs, mensaje }
        repetidos: 0
      };
      this.camaras.set(camaraId, c);
    }
    return c;
  }

  /** Empieza una suscripcion nueva (primera vez o reconexion). */
  conectar(camaraId, ahoraMs) {
    const c = this._cam(camaraId);
    c.conectado = true;
    c.inicioSyncMs = ahoraMs;
    c.claves.clear();
    c.pendienteMov = null;
    this.alDiagnostico({ tipo: 'conectado', camaraId });
  }

  /** Se perdio la conexion: se olvida lo que se sabia y se cancela lo pendiente. */
  desconectar(camaraId) {
    const c = this._cam(camaraId);
    const eraConectado = c.conectado;
    c.conectado = false;
    c.claves.clear();
    c.pendienteMov = null;
    if (eraConectado) this.alDiagnostico({ tipo: 'desconectado', camaraId });
  }

  /**
   * Procesa un mensaje.
   * @param {string} camaraId
   * @param {object} m  { detector:'persona'|'movimiento', valor:boolean, topic, utc, operacion, fuente, regla }
   * @param {number} ahoraMs  instante de llegada (el reloj del servidor, no el de la camara)
   */
  procesar(camaraId, m, ahoraMs) {
    const c = this._cam(camaraId);
    if (!DETECTORES.includes(m.detector) || typeof m.valor !== 'boolean') {
      this.alDiagnostico({ tipo: 'ignorado_formato', camaraId, mensaje: m });
      return;
    }
    if (!c.conectado) {
      this.alDiagnostico({ tipo: 'ignorado_desconectado', camaraId, mensaje: m });
      return;
    }

    const clave = `${m.detector}|${m.fuente || ''}|${m.regla || ''}`;
    const previo = c.claves.get(clave);

    if (previo === undefined) {
      c.claves.set(clave, { valor: m.valor, desde: ahoraMs });
      if (ahoraMs - c.inicioSyncMs <= this.ventanaSyncMs) {
        this.alDiagnostico({ tipo: 'sincronizacion', camaraId, clave, valor: m.valor, operacion: m.operacion });
        return;
      }
      if (!m.valor) {
        this.alDiagnostico({ tipo: 'primer_valor_falso', camaraId, clave });
        return;
      }
      // Primer valor true fuera de la ventana: subida real
    } else if (previo.valor === m.valor) {
      c.repetidos++;
      this.alDiagnostico({ tipo: 'repetido', camaraId, clave, valor: m.valor, operacion: m.operacion });
      return;
    } else {
      c.claves.set(clave, { valor: m.valor, desde: ahoraMs });
    }

    this.alEvento({
      camaraId, detector: m.detector, valor: m.valor,
      transicion: m.valor ? 'subida' : 'bajada',
      topic: m.topic, utc: m.utc, operacion: m.operacion, fuente: m.fuente, regla: m.regla, ahoraMs
    });
    if (m.valor) this._subida(camaraId, c, m, ahoraMs);
  }

  _subida(camaraId, c, m, ahoraMs) {
    if (m.detector === 'persona') {
      if (c.pendienteMov) {
        c.pendienteMov = null;
        this.alDiagnostico({ tipo: 'movimiento_absorbido_por_persona', camaraId });
      }
      if (ahoraMs - c.ultAlerta.persona < this.cooldownPersonaMs) {
        this.alDiagnostico({ tipo: 'cooldown', camaraId, detector: 'persona' });
        return;
      }
      c.ultAlerta.persona = ahoraMs;
      this.alAlerta({ camaraId, detector: 'persona', topic: m.topic, utc: m.utc, fuente: m.fuente, regla: m.regla, ahoraMs });
      return;
    }

    // Movimiento
    if (this._personaPresente(c) || ahoraMs - c.ultAlerta.persona < this.cooldownPersonaMs) {
      this.alDiagnostico({ tipo: 'movimiento_cubierto_por_persona', camaraId });
      return;
    }
    if (c.pendienteMov) {
      this.alDiagnostico({ tipo: 'movimiento_ya_pendiente', camaraId });
      return;
    }
    if (ahoraMs - c.ultAlerta.movimiento < this.cooldownMovimientoMs) {
      this.alDiagnostico({ tipo: 'cooldown', camaraId, detector: 'movimiento' });
      return;
    }
    // Se espera dedupMs: si en ese tiempo llega una persona, este movimiento no avisa
    c.pendienteMov = { dueMs: ahoraMs + this.dedupMs, mensaje: m };
  }

  /** Debe llamarse con frecuencia (cada segundo basta): libera los movimientos que esperaban. */
  tick(ahoraMs) {
    for (const [camaraId, c] of this.camaras) {
      const p = c.pendienteMov;
      if (!p || ahoraMs < p.dueMs) continue;
      c.pendienteMov = null;
      if (!c.conectado) continue;
      if (this._personaPresente(c) || ahoraMs - c.ultAlerta.persona < this.cooldownPersonaMs) {
        this.alDiagnostico({ tipo: 'movimiento_cubierto_por_persona', camaraId });
        continue;
      }
      c.ultAlerta.movimiento = ahoraMs;
      const m = p.mensaje;
      this.alAlerta({ camaraId, detector: 'movimiento', topic: m.topic, utc: m.utc, fuente: m.fuente, regla: m.regla, ahoraMs });
    }
  }

  _personaPresente(c) {
    for (const [k, v] of c.claves) if (k.startsWith('persona|') && v.valor) return true;
    return false;
  }

  /**
   * Estado actual de una camara. Un detector es null (desconocido) si no hay
   * conexion o si todavia no se ha recibido ningun valor suyo.
   */
  estado(camaraId) {
    const c = this.camaras.get(camaraId);
    if (!c || !c.conectado) return { conectado: false, persona: null, movimiento: null };
    const de = (detector) => {
      let hay = false;
      for (const [k, v] of c.claves) {
        if (!k.startsWith(`${detector}|`)) continue;
        hay = true;
        if (v.valor) return true;
      }
      return hay ? false : null;
    };
    return { conectado: true, persona: de('persona'), movimiento: de('movimiento'), repetidos: c.repetidos };
  }
}

module.exports = { MotorEventos };
