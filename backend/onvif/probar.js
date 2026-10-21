#!/usr/bin/env node
/*
 * Prueba manual de ONVIF contra la camara REAL (no necesita base de datos ni
 * el resto del backend). Sirve para comprobar en el VPS, con la MC210 a traves
 * del tunel, justo lo que la prueba automatica solo puede simular:
 *
 *   - que la camara acepta la autenticacion y la hora;
 *   - que direcciones anuncia (las internas, 192.168.x.x, se reescriben);
 *   - que topics publica realmente (GetEventProperties);
 *   - que mensajes llegan al caminar frente a ella, con su PropertyOperation;
 *   - como los interpreta el motor de estados (eventos y alertas).
 *
 * Uso (dentro del contenedor del backend, o con Node en el VPS):
 *   ONVIF_USUARIO=usuario ONVIF_CLAVE=clave node onvif/probar.js [segundos]
 *   ONVIF_HOST=10.8.0.2 ONVIF_PUERTO=2020 ONVIF_LOG_XML=/tmp/onvif.xml.log node onvif/probar.js 90
 *
 * La clave se lee del entorno para que no quede en el historial del shell ni
 * en la lista de procesos. El registro XML, si se activa, oculta las credenciales.
 */

const { ClienteOnvif, ErrorOnvif } = require('./cliente');
const { MotorEventos } = require('./estados');
const { crearRegistroXml } = require('./registro_xml');

const host = process.env.ONVIF_HOST || '10.8.0.2';
const puerto = Number(process.env.ONVIF_PUERTO || 2020);
const usuario = process.env.ONVIF_USUARIO || '';
const clave = process.env.ONVIF_CLAVE || '';
const segundos = Number(process.argv[2] || 60);
const rutaXml = process.env.ONVIF_LOG_XML || '';

const hora = () => new Date().toISOString().slice(11, 19);
const linea = (...a) => console.log(`[${hora()}]`, ...a);

async function main() {
  if (!usuario || !clave) {
    console.error('Faltan ONVIF_USUARIO y ONVIF_CLAVE (la cuenta de la camara).');
    process.exit(2);
  }
  const cliente = new ClienteOnvif({ host, puerto, usuario, clave, registroXml: crearRegistroXml(rutaXml, { secretos: [clave] }) });
  const contadores = { consultas: 0, cortes: 0, cortesSeguidos: 0, mensajes: 0, operaciones: {}, valores: {} };
  const motor = new MotorEventos({
    cooldownPersonaMs: 60000, cooldownMovimientoMs: 120000, dedupMs: 3000, ventanaSyncMs: 5000,
    alEvento: (e) => linea(`  >> EVENTO  ${e.detector} ${e.transicion}`),
    alAlerta: (a) => linea(`  >> ALERTA  ${a.detector}  (esto avisaria al residente)`),
    alDiagnostico: (d) => { if (['sincronizacion', 'repetido', 'cooldown', 'movimiento_cubierto_por_persona'].includes(d.tipo)) linea(`  .. ${d.tipo}${d.valor !== undefined ? ` (${d.valor})` : ''}`); }
  });

  linea(`Camara ${host}:${puerto}, usuario ${usuario}`);
  const h = await cliente.horaCamara();
  linea(`Hora de la camara (UTC): ${new Date(h.camaraMs).toISOString()}  | diferencia con este equipo: ${Math.round(h.desfaseMs)} ms`);

  const ev = await cliente.direccionEventos();
  linea(`Servicio de eventos anunciado: ${ev.original}`);
  if (ev.original !== ev.url) linea(`  (se usa ${ev.url}: la camara anuncia su direccion interna)`);

  const topics = await cliente.propiedadesEventos(ev.url, ev.original);
  linea(`Topics que publica la camara (${topics.length}):`);
  for (const t of topics) linea(`   ${t}`);
  for (const esperado of ['RuleEngine/PeopleDetector/People', 'RuleEngine/CellMotionDetector/Motion']) {
    linea(`   ${topics.some((t) => t.endsWith(esperado)) ? 'OK      ' : 'NO ESTA '} ${esperado}`);
  }

  const sus = await cliente.crearSuscripcion(ev.url, ev.original, 60);
  linea(`Suscripcion creada: ${sus.url}`);
  motor.conectar('probar', Date.now());
  let renovarEn = Date.now() + 30000;
  const fin = Date.now() + segundos * 1000;
  linea(`Escuchando ${segundos} s. Camina frente a la camara, sal del encuadre, mueve algo sin que aparezca una persona...`);

  try {
    while (Date.now() < fin) {
      if (Date.now() >= renovarEn) { await cliente.renovar(sus, 60); renovarEn = Date.now() + 30000; linea('  (suscripcion renovada)'); }
      const t0 = Date.now();
      let msgs;
      try {
        msgs = await cliente.extraer(sus, { esperaS: Math.min(10, Math.max(1, Math.ceil((fin - Date.now()) / 1000))) });
        contadores.consultas++;
      } catch (e) {
        if (!(e instanceof ErrorOnvif && e.transitorio) || contadores.cortesSeguidos >= 3) throw e;
        contadores.cortes++; contadores.cortesSeguidos++;
        linea(`  !! la camara cerro la conexion tras ${Date.now() - t0} ms (${e.causa}); se repite la espera (la suscripcion sigue viva)`);
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      contadores.cortesSeguidos = 0;
      for (const m of msgs) {
        contadores.mensajes++;
        contadores.operaciones[m.operacion] = (contadores.operaciones[m.operacion] || 0) + 1;
        const clv = `${m.detector}=${m.valor}`;
        contadores.valores[clv] = (contadores.valores[clv] || 0) + 1;
        linea(`MENSAJE ${m.topic}  operacion=${m.operacion}  ${m.detector || '(otro)'}=${m.valor}  regla=${m.regla}  utc=${m.utc}`);
        motor.procesar('probar', m, Date.now());
      }
      motor.tick(Date.now());
    }
  } finally {
    await cliente.cancelar(sus);
  }

  console.log('\n===== Resumen =====');
  console.log(`Mensajes recibidos: ${contadores.mensajes} en ${contadores.consultas} consultas; cortes de conexion recuperados: ${contadores.cortes}`);
  console.log('PropertyOperation vistas:', JSON.stringify(contadores.operaciones));
  console.log('Valores vistos:', JSON.stringify(contadores.valores));
  const est = motor.estado('probar');
  console.log(`Estado final segun el motor: persona=${est.persona} movimiento=${est.movimiento}`);
  if (rutaXml) console.log(`XML original (sin credenciales) en ${rutaXml}`);
  console.log('Si PropertyOperation es siempre "Initialized" pero los valores cambian al moverte, es el comportamiento de la MC210 descrito: el motor se basa en los valores, no en la operacion.');
}

main().catch((e) => {
  console.error(e instanceof ErrorOnvif ? `Error ONVIF (${e.tipo}): ${e.message}` : e);
  process.exit(1);
});
