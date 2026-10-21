/*
 * Cliente ONVIF minimo: solo lo necesario para recibir eventos por PullPoint.
 *
 * Operaciones:
 *   GetSystemDateAndTime         hora de la camara (sin autenticacion)
 *   GetServices / GetCapabilities  direccion del servicio de eventos
 *   GetEventProperties           topics que la camara realmente publica
 *   CreatePullPointSubscription  crea la suscripcion
 *   PullMessages                 espera mensajes (long polling)
 *   Renew / Unsubscribe          mantiene o cierra la suscripcion
 *
 * Detalles que importan en este proyecto:
 *   - La camara esta detras del ESP32 (NAT), y sus respuestas traen su direccion
 *     INTERNA (192.168.x.x). Todas las direcciones devueltas se reescriben al
 *     host y puerto que si son alcanzables (el del tunel). Para el campo
 *     wsa:To se conserva la direccion original que dio la camara.
 *   - La autenticacion es WS-Security con PasswordDigest. El digest depende de
 *     la hora de la camara, asi que se corrige con la diferencia medida con
 *     GetSystemDateAndTime.
 *   - Se usa solo el fetch de Node y un lector de XML; no hay mas dependencias.
 */

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wsa: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'
};
const ACCION = {
  crear: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest',
  propiedades: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/GetEventPropertiesRequest',
  extraer: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
  renovar: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
  cancelar: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest'
};
const NS_EVENTOS = 'http://www.onvif.org/ver10/events/wsdl';

class ErrorOnvif extends Error {
  constructor(mensaje, { tipo = 'error', http = null, falla = null, causa = null, transitorio = false } = {}) {
    super(mensaje);
    this.causa = causa;            // codigo de red de Node, por ejemplo UND_ERR_SOCKET
    this.transitorio = transitorio; // corte de conexion inmediato: vale la pena repetir la misma peticion
    this.name = 'ErrorOnvif';
    this.tipo = tipo;      // 'red' | 'http' | 'credenciales' | 'falla' | 'suscripcion_expirada' | 'formato'
    this.http = http;
    this.falla = falla;
  }
}

const analizador = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (nombre) => ['NotificationMessage', 'SimpleItem', 'Service'].includes(nombre)
});

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const texto = (n) => (n == null ? '' : typeof n === 'object' ? String(n['#text'] ?? '') : String(n));
const lista = (n) => (n == null ? [] : Array.isArray(n) ? n : [n]);

class ClienteOnvif {
  /**
   * @param {object} cfg { host, puerto, usuario, clave, timeoutMs, registroXml, fetch }
   */
  constructor(cfg) {
    this.host = cfg.host;
    this.puerto = cfg.puerto || 2020;
    this.usuario = cfg.usuario || '';
    this.clave = cfg.clave || '';
    this.timeoutMs = cfg.timeoutMs || 10000;
    this.registroXml = cfg.registroXml || null;
    this._fetch = cfg.fetch || fetch;
    this.desfaseMs = 0;                          // hora de la camara menos hora local
    this.urlDispositivo = `http://${this.host}:${this.puerto}/onvif/device_service`;
  }

  // ---------- Direcciones ----------

  /** Cambia host y puerto de una URL por los alcanzables; conserva ruta y consulta. */
  reescribir(url) {
    try {
      const u = new URL(url);
      return `http://${this.host}:${this.puerto}${u.pathname}${u.search}`;
    } catch (e) {
      throw new ErrorOnvif(`Direccion invalida devuelta por la camara: ${url}`, { tipo: 'formato' });
    }
  }

  // ---------- Seguridad y construccion de mensajes ----------

  _seguridad() {
    if (!this.usuario) return '';
    const nonce = crypto.randomBytes(16);
    const creado = new Date(Date.now() + this.desfaseMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(creado), Buffer.from(this.clave)])).digest('base64');
    return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
      `<wsse:UsernameToken><wsse:Username>${esc(this.usuario)}</wsse:Username>` +
      `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>` +
      `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>` +
      `<wsu:Created>${creado}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
  }

  _sobre(cuerpo, { autenticar = true, accion = null, para = null } = {}) {
    let cab = '';
    if (accion) cab += `<wsa:Action s:mustUnderstand="1" xmlns:wsa="${NS.wsa}">${accion}</wsa:Action>`;
    if (para) cab += `<wsa:To s:mustUnderstand="1" xmlns:wsa="${NS.wsa}">${esc(para)}</wsa:To>`;
    if (autenticar) cab += this._seguridad();
    return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.s}"><s:Header>${cab}</s:Header><s:Body>${cuerpo}</s:Body></s:Envelope>`;
  }

  // ---------- Transporte ----------

  async _soap(url, cuerpo, opc = {}) {
    const { autenticar = true, accion = null, para = null, timeoutMs = this.timeoutMs } = opc;
    const sobre = this._sobre(cuerpo, { autenticar, accion, para });
    if (this.registroXml) this.registroXml('->', url, sobre);
    let r, crudo;
    try {
      r = await this._fetch(url, {
        method: 'POST',
        // Connection: close porque el servidor HTTP de la camara cierra el socket tras cada
        // respuesta; reutilizarlo hacia fallar la peticion siguiente ("fetch failed").
        headers: { 'Content-Type': `application/soap+xml; charset=utf-8${accion ? `; action="${accion}"` : ''}`, 'Connection': 'close' },
        body: sobre,
        signal: AbortSignal.timeout(timeoutMs)
      });
      crudo = await r.text();
    } catch (e) {
      const causa = e.cause && (e.cause.code || e.cause.message);
      const agotado = e.name === 'TimeoutError';
      throw new ErrorOnvif(`Sin respuesta de la camara (${agotado ? 'tiempo agotado' : e.message}${causa ? `: ${causa}` : ''})`,
        { tipo: 'red', causa: causa || null, transitorio: !agotado && /^(UND_ERR_SOCKET|ECONNRESET|EPIPE)$/.test(String(causa || '')) });
    }
    if (this.registroXml) this.registroXml('<-', `${url} [HTTP ${r.status}]`, crudo);

    let doc = null;
    try { doc = analizador.parse(crudo); } catch (e) { /* se maneja abajo */ }
    const cuerpoResp = doc && doc.Envelope && doc.Envelope.Body;
    const falla = cuerpoResp && cuerpoResp.Fault;

    if (r.status === 401 || r.status === 403) {
      throw new ErrorOnvif('La camara rechazo las credenciales ONVIF.', { tipo: 'credenciales', http: r.status });
    }
    if (falla) {
      const detalle = JSON.stringify(falla);
      if (/ResourceUnknown/.test(detalle)) {
        throw new ErrorOnvif('La suscripcion ya no existe en la camara.', { tipo: 'suscripcion_expirada', http: r.status, falla: detalle });
      }
      if (/NotAuthorized|Sender not Authorized|FailedAuthentication/i.test(detalle)) {
        throw new ErrorOnvif('La camara rechazo las credenciales ONVIF.', { tipo: 'credenciales', http: r.status, falla: detalle });
      }
      throw new ErrorOnvif(`Falla SOAP: ${texto(falla.Reason && falla.Reason.Text) || texto(falla.faultstring) || detalle.slice(0, 200)}`, { tipo: 'falla', http: r.status, falla: detalle });
    }
    if (!r.ok) throw new ErrorOnvif(`HTTP ${r.status} de la camara`, { tipo: 'http', http: r.status });
    if (!cuerpoResp) throw new ErrorOnvif('Respuesta de la camara no reconocible como SOAP.', { tipo: 'formato', http: r.status });
    return cuerpoResp;
  }

  // ---------- Operaciones ----------

  /** Mide la diferencia de reloj con la camara. Sin autenticacion. */
  async horaCamara() {
    const t0 = Date.now();
    const b = await this._soap(this.urlDispositivo, `<tds:GetSystemDateAndTime xmlns:tds="${NS.tds}"/>`, { autenticar: false });
    const u = b.GetSystemDateAndTimeResponse && b.GetSystemDateAndTimeResponse.SystemDateAndTime
      && b.GetSystemDateAndTimeResponse.SystemDateAndTime.UTCDateTime;
    if (!u || !u.Date || !u.Time) throw new ErrorOnvif('GetSystemDateAndTime sin fecha UTC.', { tipo: 'formato' });
    const camaraMs = Date.UTC(+u.Date.Year, +u.Date.Month - 1, +u.Date.Day, +u.Time.Hour, +u.Time.Minute, +u.Time.Second);
    this.desfaseMs = camaraMs - (t0 + (Date.now() - t0) / 2);
    return { camaraMs, desfaseMs: this.desfaseMs };
  }

  /** Direccion del servicio de eventos, ya reescrita a la alcanzable. */
  async direccionEventos() {
    let original = null;
    try {
      const b = await this._soap(this.urlDispositivo,
        `<tds:GetServices xmlns:tds="${NS.tds}"><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>`);
      const servicios = lista(b.GetServicesResponse && b.GetServicesResponse.Service);
      const ev = servicios.find((x) => texto(x.Namespace) === NS_EVENTOS);
      if (ev) original = texto(ev.XAddr);
    } catch (e) {
      if (e.tipo === 'credenciales') throw e;
      // Algunas camaras no implementan GetServices: se prueba GetCapabilities
    }
    if (!original) {
      const b = await this._soap(this.urlDispositivo,
        `<tds:GetCapabilities xmlns:tds="${NS.tds}"><tds:Category>Events</tds:Category></tds:GetCapabilities>`);
      const caps = b.GetCapabilitiesResponse && b.GetCapabilitiesResponse.Capabilities;
      original = caps && caps.Events && texto(caps.Events.XAddr);
    }
    if (!original) throw new ErrorOnvif('La camara no anuncia el servicio de eventos.', { tipo: 'formato' });
    return { original, url: this.reescribir(original) };
  }

  /** Lista de topics que la camara publica (por ejemplo "RuleEngine/PeopleDetector/People"). */
  async propiedadesEventos(urlEventos, direccionOriginal) {
    const b = await this._soap(urlEventos, `<tev:GetEventProperties xmlns:tev="${NS.tev}"/>`,
      { accion: ACCION.propiedades, para: direccionOriginal || urlEventos });
    const r = b.GetEventPropertiesResponse;
    const conjunto = r && r.TopicSet;
    const topics = [];
    const recorrer = (nodo, ruta) => {
      if (!nodo || typeof nodo !== 'object') return;
      for (const [k, v] of Object.entries(nodo)) {
        if (k.startsWith('@_') || k === '#text') continue;
        const hijo = Array.isArray(v) ? v[0] : v;
        const sub = ruta ? `${ruta}/${k}` : k;
        if (hijo && typeof hijo === 'object' && hijo['@_topic'] === 'true') topics.push(sub);
        recorrer(hijo, sub);
      }
    };
    recorrer(conjunto, '');
    return topics;
  }

  /** Crea la suscripcion. Devuelve la direccion alcanzable y la original. */
  async crearSuscripcion(urlEventos, direccionOriginal, segundos) {
    const b = await this._soap(urlEventos,
      `<tev:CreatePullPointSubscription xmlns:tev="${NS.tev}"><tev:InitialTerminationTime>PT${Math.round(segundos)}S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`,
      { accion: ACCION.crear, para: direccionOriginal || urlEventos });
    const r = b.CreatePullPointSubscriptionResponse;
    const ref = r && r.SubscriptionReference;
    const dir = ref && texto(ref.Address);
    if (!dir) throw new ErrorOnvif('La camara no devolvio la direccion de la suscripcion.', { tipo: 'formato' });
    return { original: dir, url: this.reescribir(dir) };
  }

  /** Espera mensajes. Con long polling la camara responde al llegar uno o al vencer el tiempo. */
  async extraer(sus, { esperaS = 20, limite = 20 } = {}) {
    const b = await this._soap(sus.url,
      `<tev:PullMessages xmlns:tev="${NS.tev}"><tev:Timeout>PT${Math.round(esperaS)}S</tev:Timeout><tev:MessageLimit>${limite}</tev:MessageLimit></tev:PullMessages>`,
      { accion: ACCION.extraer, para: sus.original, timeoutMs: esperaS * 1000 + 10000 });
    const r = b.PullMessagesResponse;
    if (!r) throw new ErrorOnvif('Respuesta a PullMessages sin contenido.', { tipo: 'formato' });
    return lista(r.NotificationMessage).map(interpretarNotificacion).filter(Boolean);
  }

  async renovar(sus, segundos) {
    await this._soap(sus.url,
      `<wsnt:Renew xmlns:wsnt="${NS.wsnt}"><wsnt:TerminationTime>PT${Math.round(segundos)}S</wsnt:TerminationTime></wsnt:Renew>`,
      { accion: ACCION.renovar, para: sus.original });
  }

  async cancelar(sus) {
    try {
      await this._soap(sus.url, `<wsnt:Unsubscribe xmlns:wsnt="${NS.wsnt}"/>`,
        { accion: ACCION.cancelar, para: sus.original, timeoutMs: 4000 });
    } catch (e) { /* mejor esfuerzo: si la camara no responde, la suscripcion caduca sola */ }
  }
}

/**
 * Convierte un NotificationMessage en un objeto plano:
 * { topic, utc, operacion, fuente, regla, datos, detector, valor }
 * detector/valor salen del nombre del dato (IsPeople / IsMotion), no del topic,
 * porque los topics pueden verse truncados o variar entre firmwares.
 */
function interpretarNotificacion(n) {
  const topic = texto(n.Topic).trim();
  const interno = n.Message && n.Message.Message;
  if (!interno) return null;
  const items = (x) => lista(x && x.SimpleItem).map((i) => ({ nombre: i['@_Name'], valor: i['@_Value'] }));
  const fuenteItems = items(interno.Source);
  const datosItems = items(interno.Data);

  const datos = {};
  for (const d of datosItems) datos[d.nombre] = d.valor;
  const fuentes = {};
  for (const f of fuenteItems) fuentes[f.nombre] = f.valor;

  let detector = null, valor = null;
  const aBool = (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : null);
  if ('IsPeople' in datos) { detector = 'persona'; valor = aBool(datos.IsPeople); }
  else if ('IsMotion' in datos) { detector = 'movimiento'; valor = aBool(datos.IsMotion); }

  const fuente = fuenteItems.filter((f) => /VideoSource/i.test(f.nombre)).map((f) => f.valor).join('+')
    || fuenteItems.filter((f) => !/Rule/i.test(f.nombre)).map((f) => f.valor).join('+');
  const regla = (fuenteItems.find((f) => /^Rule$/i.test(f.nombre)) || {}).valor || '';

  return {
    topic, utc: interno['@_UtcTime'] || null, operacion: interno['@_PropertyOperation'] || null,
    fuente, regla, fuentes, datos, detector, valor
  };
}

module.exports = { ClienteOnvif, ErrorOnvif, interpretarNotificacion, NS_EVENTOS };
