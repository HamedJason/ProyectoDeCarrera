/*
 * Camara ONVIF simulada para las pruebas. Imita lo que se sabe de la MC210:
 *   - autentica con WS-Security (PasswordDigest) y compara la hora con su reloj;
 *   - anuncia sus servicios con su direccion INTERNA (192.168.4.2:2020), que el
 *     cliente debe reescribir;
 *   - manda siempre PropertyOperation="Initialized", cambie o no el valor;
 *   - PullMessages es long polling.
 * Tambien permite provocar fallos: expirar la suscripcion, caer, hora distinta.
 */

const http = require('http');
const crypto = require('crypto');

const IP_INTERNA = '192.168.4.2:2020';

function nombreOperacion(xml) {
  const cuerpo = xml.match(/<(?:\w+:)?Body[^>]*>\s*<(?:\w+:)?(\w+)/);
  return cuerpo ? cuerpo[1] : null;
}

function iniciarCamaraFalsa({ usuario = 'cam', clave = 'secreta', desfaseHoraMs = 0, sinEstadoInicial = false } = {}) {
  const e = {
    desfaseHoraMs, usuario, clave,
    suscripciones: new Map(),        // id -> { expira, cola, esperando }
    contadores: { crear: 0, extraer: 0, renovar: 0, cancelar: 0, autenticacionFallida: 0, direcciones: [] },
    xmlRecibidos: [],
    caida: false,
    cortarAlVencer: false,           // como la MC210: al agotarse la espera cierra el socket en vez de responder vacio
    cortarPulls: 0                   // cierra el socket en las proximas N esperas (la suscripcion sigue viva)
  };
  let siguienteId = 1;
  let puerto = 0;

  const ahoraCamara = () => Date.now() + e.desfaseHoraMs;

  const sobre = (cuerpo) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"><SOAP-ENV:Body>${cuerpo}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const falla = (codigo, razon) => `<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>${codigo}</SOAP-ENV:Value></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${razon}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`;

  function autenticado(xml) {
    const u = (xml.match(/<(?:\w+:)?Username>([^<]*)</) || [])[1];
    const d = (xml.match(/<(?:\w+:)?Password[^>]*>([^<]*)</) || [])[1];
    const n = (xml.match(/<(?:\w+:)?Nonce[^>]*>([^<]*)</) || [])[1];
    const c = (xml.match(/<(?:\w+:)?Created[^>]*>([^<]*)</) || [])[1];
    if (u !== e.usuario || !d || !n || !c) return false;
    // La hora del mensaje debe estar cerca de la de ESTA camara (tolerancia de 60 s)
    if (Math.abs(Date.parse(c) - ahoraCamara()) > 60000) return false;
    const esperado = crypto.createHash('sha1')
      .update(Buffer.concat([Buffer.from(n, 'base64'), Buffer.from(c), Buffer.from(e.clave)])).digest('base64');
    return esperado === d;
  }

  function mensajeXml({ topic, tipo, valor, operacion = 'Initialized', regla }) {
    const nombreDato = tipo === 'persona' ? 'IsPeople' : 'IsMotion';
    return `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ug/Topics/TopicExpression/ConcreteSet">${topic}</wsnt:Topic><wsnt:Message>` +
      `<tt:Message UtcTime="${new Date(ahoraCamara()).toISOString()}" PropertyOperation="${operacion}">` +
      `<tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"/><tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="vaconf"/><tt:SimpleItem Name="Rule" Value="${regla}"/></tt:Source>` +
      `<tt:Data><tt:SimpleItem Name="${nombreDato}" Value="${valor}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
  }

  const TOPIC = { persona: 'tns1:RuleEngine/PeopleDetector/People', movimiento: 'tns1:RuleEngine/CellMotionDetector/Motion' };
  const REGLA = { persona: 'MyPeopleDetectorRule', movimiento: 'MyMotionDetectorRule' };

  function responder(res, estado, cuerpo) {
    res.writeHead(estado, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
    res.end(sobre(cuerpo));
  }

  function despertar(sus) {
    if (sus.esperando) { const f = sus.esperando; sus.esperando = null; f(); }
  }

  const servidor = http.createServer((req, res) => {
    let datos = '';
    req.on('data', (c) => { datos += c; });
    req.on('end', () => {
      e.xmlRecibidos.push(datos);
      if (e.caida) return req.socket.destroy();
      const op = nombreOperacion(datos);

      if (op === 'GetSystemDateAndTime') {
        const d = new Date(ahoraCamara());
        return responder(res, 200,
          `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
      }

      if (!autenticado(datos)) {
        e.contadores.autenticacionFallida++;
        res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
        return res.end(sobre(falla('SOAP-ENV:Sender', 'Sender not Authorized')));
      }

      if (op === 'GetServices') {
        return responder(res, 200,
          `<tds:GetServicesResponse><tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>http://${IP_INTERNA}/onvif/device_service</tds:XAddr></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver10/events/wsdl</tds:Namespace><tds:XAddr>http://${IP_INTERNA}/onvif/event_service</tds:XAddr></tds:Service></tds:GetServicesResponse>`);
      }

      if (op === 'GetEventProperties') {
        return responder(res, 200,
          `<tev:GetEventPropertiesResponse><tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation><wsnt:FixedTopicSet>true</wsnt:FixedTopicSet><wstop:TopicSet><tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/></tt:Data></tt:MessageDescription></Motion></CellMotionDetector><PeopleDetector><People wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="IsPeople" Type="xs:boolean"/></tt:Data></tt:MessageDescription></People></PeopleDetector></tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>`);
      }

      if (op === 'CreatePullPointSubscription') {
        e.contadores.crear++;
        const id = String(siguienteId++);
        const seg = Number((datos.match(/PT(\d+)S/) || [])[1] || 60);
        const sus = { id, expira: Date.now() + seg * 1000, cola: [], esperando: null };
        if (!sinEstadoInicial) {
          // Estado inicial, como hace la MC210 al suscribirse
          sus.cola.push(mensajeXml({ topic: TOPIC.persona, tipo: 'persona', valor: false, regla: REGLA.persona }));
          sus.cola.push(mensajeXml({ topic: TOPIC.movimiento, tipo: 'movimiento', valor: false, regla: REGLA.movimiento }));
        }
        e.suscripciones.set(id, sus);
        return responder(res, 200,
          `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>http://${IP_INTERNA}/onvif/subscription/${id}</wsa5:Address></tev:SubscriptionReference><wsnt:CurrentTime>${new Date().toISOString()}</wsnt:CurrentTime><wsnt:TerminationTime>${new Date(sus.expira).toISOString()}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`);
      }

      const m = req.url.match(/\/onvif\/subscription\/(\d+)/);
      const sus = m && e.suscripciones.get(m[1]);
      if (['PullMessages', 'Renew', 'Unsubscribe'].includes(op)) {
        if (/<(?:\w+:)?To[^>]*>([^<]*)</.test(datos)) e.contadores.direcciones.push(datos.match(/<(?:\w+:)?To[^>]*>([^<]*)</)[1]);
        if (!sus || Date.now() > sus.expira) {
          res.writeHead(500, { 'Content-Type': 'application/soap+xml' });
          return res.end(sobre(falla('SOAP-ENV:Sender', 'ResourceUnknownFault: la suscripcion no existe')));
        }
      }

      if (op === 'Renew') {
        e.contadores.renovar++;
        const seg = Number((datos.match(/PT(\d+)S/) || [])[1] || 60);
        sus.expira = Date.now() + seg * 1000;
        return responder(res, 200, `<wsnt:RenewResponse><wsnt:TerminationTime>${new Date(sus.expira).toISOString()}</wsnt:TerminationTime><wsnt:CurrentTime>${new Date().toISOString()}</wsnt:CurrentTime></wsnt:RenewResponse>`);
      }

      if (op === 'Unsubscribe') {
        e.contadores.cancelar++;
        e.suscripciones.delete(m[1]);
        return responder(res, 200, '<wsnt:UnsubscribeResponse/>');
      }

      if (op === 'PullMessages') {
        e.contadores.extraer++;
        if (e.cortarPulls > 0) { e.cortarPulls--; return req.socket.destroy(); }
        const seg = Number((datos.match(/PT(\d+)S/) || [])[1] || 1);
        const entregar = () => {
          const lote = sus.cola.splice(0, 20);
          if (res.writableEnded) return;
          responder(res, 200, `<tev:PullMessagesResponse><tev:CurrentTime>${new Date().toISOString()}</tev:CurrentTime><tev:TerminationTime>${new Date(sus.expira).toISOString()}</tev:TerminationTime>${lote.join('')}</tev:PullMessagesResponse>`);
        };
        if (sus.cola.length) return entregar();
        const temporizador = setTimeout(() => { sus.esperando = null; if (e.cortarAlVencer) return req.socket.destroy(); entregar(); }, seg * 1000);
        sus.esperando = () => { clearTimeout(temporizador); setTimeout(entregar, 5); };
        res.on('close', () => { clearTimeout(temporizador); if (sus.esperando) sus.esperando = null; });
        return undefined;
      }

      res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
      return res.end(sobre(falla('SOAP-ENV:Sender', `Operacion no soportada: ${op}`)));
    });
  });

  e.iniciar = () => new Promise((ok) => servidor.listen(puerto, '127.0.0.1', () => { puerto = servidor.address().port; e.puerto = puerto; ok(e); }));
  e.cerrar = () => new Promise((ok) => { servidor.closeAllConnections(); servidor.close(() => ok()); });

  /** Emite un cambio. operacion queda en "Initialized" por defecto, como la MC210. */
  e.emitir = ({ tipo, valor, operacion = 'Initialized' }) => {
    for (const sus of e.suscripciones.values()) {
      sus.cola.push(mensajeXml({ topic: TOPIC[tipo], tipo, valor, operacion, regla: REGLA[tipo] }));
      despertar(sus);
    }
  };
  /** La camara olvida las suscripciones (reinicio o expiracion por su lado). */
  e.olvidarSuscripciones = () => { for (const s of e.suscripciones.values()) { despertar(s); } e.suscripciones.clear(); };
  e.caer = () => { e.caida = true; for (const s of e.suscripciones.values()) despertar(s); servidor.closeAllConnections(); };
  e.recuperar = () => { e.caida = false; };
  e.suscripcionesActivas = () => e.suscripciones.size;

  return e.iniciar();
}

module.exports = { iniciarCamaraFalsa, IP_INTERNA };
