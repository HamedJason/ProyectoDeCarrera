const test = require('node:test');
const assert = require('node:assert/strict');
const { MotorEventos } = require('../onvif/estados');

// Crea un motor que anota todo lo que ocurre
function nuevo(opc = {}) {
  const r = { eventos: [], alertas: [], diag: [] };
  const motor = new MotorEventos({
    cooldownPersonaMs: 60000, cooldownMovimientoMs: 120000, dedupMs: 3000, ventanaSyncMs: 5000,
    ...opc,
    alEvento: (e) => r.eventos.push(e),
    alAlerta: (a) => r.alertas.push(a),
    alDiagnostico: (d) => r.diag.push(d)
  });
  return { motor, r };
}
const P = (valor, extra = {}) => ({ detector: 'persona', valor, topic: 'tns1:RuleEngine/PeopleDetector/People', operacion: 'Initialized', fuente: 'src1', regla: 'MyPeopleD1', ...extra });
const M = (valor, extra = {}) => ({ detector: 'movimiento', valor, topic: 'tns1:RuleEngine/CellMotionDetector/Motion', operacion: 'Initialized', fuente: 'src1', regla: 'MyMotion1', ...extra });
const tipos = (r, t) => r.diag.filter((d) => d.tipo === t).length;

test('el primer mensaje tras conectar es sincronizacion: sin evento ni alerta, aunque sea true', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(true), 1000);
  assert.equal(r.eventos.length, 0);
  assert.equal(r.alertas.length, 0);
  assert.equal(tipos(r, 'sincronizacion'), 1);
  assert.equal(motor.estado('c1').persona, true);
});

test('transiciones reales false->true y true->false, aunque la operacion sea siempre Initialized', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(false), 500);            // sincronizacion
  motor.procesar('c1', P(true), 10000);           // sube
  motor.procesar('c1', P(false), 20000);          // baja
  assert.deepEqual(r.eventos.map((e) => e.transicion), ['subida', 'bajada']);
  assert.ok(r.eventos.every((e) => e.operacion === 'Initialized'));
  assert.equal(r.alertas.length, 1);
  assert.equal(r.alertas[0].detector, 'persona');
});

test('mensajes repetidos con el mismo valor se ignoran y se anotan en el diagnostico', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(false), 100);
  for (let i = 0; i < 5; i++) motor.procesar('c1', P(false), 10000 + i * 1000);
  assert.equal(r.eventos.length, 0);
  assert.equal(tipos(r, 'repetido'), 5);
  assert.equal(motor.estado('c1').repetidos, 5);
});

test('cooldown de persona: la segunda subida dentro del tiempo no alerta, pero si genera evento', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(false), 100);
  motor.procesar('c1', P(true), 10000);
  motor.procesar('c1', P(false), 15000);
  motor.procesar('c1', P(true), 20000);   // 10 s despues de la alerta: cooldown
  assert.equal(r.alertas.length, 1);
  assert.equal(r.eventos.filter((e) => e.transicion === 'subida').length, 2);
  assert.equal(tipos(r, 'cooldown'), 1);
  motor.procesar('c1', P(false), 25000);
  motor.procesar('c1', P(true), 80000);   // pasaron 70 s: alerta de nuevo
  assert.equal(r.alertas.length, 2);
});

test('persona y movimiento a la vez, movimiento primero: una sola alerta (de persona)', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', M(false), 100);
  motor.procesar('c1', P(false), 100);
  motor.procesar('c1', M(true), 10000);
  motor.procesar('c1', P(true), 11000);   // dentro de los 3 s de espera
  motor.tick(20000);
  assert.deepEqual(r.alertas.map((a) => a.detector), ['persona']);
  assert.equal(r.eventos.filter((e) => e.valor).length, 2);   // ambos quedan registrados
});

test('persona y movimiento a la vez, persona primero: una sola alerta (de persona)', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', M(false), 100);
  motor.procesar('c1', P(false), 100);
  motor.procesar('c1', P(true), 10000);
  motor.procesar('c1', M(true), 10100);
  motor.tick(20000);
  assert.deepEqual(r.alertas.map((a) => a.detector), ['persona']);
});

test('movimiento sin personas: alerta solo cuando pasa la espera de deduplicacion', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', M(false), 100);
  motor.procesar('c1', M(true), 10000);
  motor.tick(11000);
  assert.equal(r.alertas.length, 0);      // todavia espera por si llega una persona
  motor.tick(13000);
  assert.deepEqual(r.alertas.map((a) => a.detector), ['movimiento']);
  motor.tick(14000);
  assert.equal(r.alertas.length, 1);      // no se repite
});

test('movimiento mientras hay una persona presente no alerta aparte', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', M(false), 100);
  motor.procesar('c1', P(false), 100);
  motor.procesar('c1', P(true), 10000);
  motor.procesar('c1', M(true), 40000);   // la persona sigue en el encuadre
  motor.tick(50000);
  assert.deepEqual(r.alertas.map((a) => a.detector), ['persona']);
  assert.equal(tipos(r, 'movimiento_cubierto_por_persona'), 1);
});

test('desconectar deja el estado desconocido y cancela lo pendiente', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(false), 100);
  motor.procesar('c1', M(false), 100);
  motor.procesar('c1', M(true), 10000);   // queda pendiente
  motor.desconectar('c1');
  motor.tick(30000);
  assert.equal(r.alertas.length, 0);
  assert.deepEqual(motor.estado('c1'), { conectado: false, persona: null, movimiento: null });
  motor.procesar('c1', P(true), 31000);   // mensaje rezagado: se ignora
  assert.equal(tipos(r, 'ignorado_desconectado'), 1);
});

test('tras reconectar, el primer mensaje vuelve a ser sincronizacion (no alerta)', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(false), 100);
  motor.desconectar('c1');
  motor.conectar('c1', 100000);
  motor.procesar('c1', P(true), 101000);  // alguien ya estaba: es sincronizacion
  assert.equal(r.alertas.length, 0);
  assert.equal(r.eventos.length, 0);
  assert.equal(motor.estado('c1').persona, true);
  motor.procesar('c1', P(false), 110000);
  assert.equal(r.eventos.length, 1);
  assert.equal(r.eventos[0].transicion, 'bajada');
});

test('primer mensaje FUERA de la ventana: true cuenta como subida; false solo se anota', () => {
  const { motor, r } = nuevo({ ventanaSyncMs: 5000 });
  motor.conectar('c1', 0);
  motor.procesar('c1', P(true), 30000);   // la camara no mando estado inicial; alguien entra
  assert.equal(r.alertas.length, 1);
  motor.procesar('c1', M(false), 31000);  // primer valor falso fuera de ventana
  assert.equal(tipos(r, 'primer_valor_falso'), 1);
  assert.equal(r.eventos.length, 1);
});

test('estado independiente por regla: dos reglas de persona', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', P(false, { regla: 'A' }), 100);
  motor.procesar('c1', P(false, { regla: 'B' }), 100);
  motor.procesar('c1', P(true, { regla: 'A' }), 10000);
  assert.equal(motor.estado('c1').persona, true);
  motor.procesar('c1', P(false, { regla: 'A' }), 12000);
  assert.equal(motor.estado('c1').persona, false);   // B sigue en false
  motor.procesar('c1', P(true, { regla: 'B' }), 13000);
  assert.equal(motor.estado('c1').persona, true);
  assert.equal(r.eventos.filter((e) => e.valor).length, 2);
});

test('estado independiente por camara', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.conectar('c2', 0);
  motor.procesar('c1', P(false), 100);
  motor.procesar('c2', P(false), 100);
  motor.procesar('c1', P(true), 10000);
  assert.equal(motor.estado('c1').persona, true);
  assert.equal(motor.estado('c2').persona, false);
  assert.equal(r.alertas.length, 1);
  assert.equal(r.alertas[0].camaraId, 'c1');
});

test('mensajes con formato inesperado se descartan sin romper nada', () => {
  const { motor, r } = nuevo();
  motor.conectar('c1', 0);
  motor.procesar('c1', { detector: 'humo', valor: true }, 100);
  motor.procesar('c1', { detector: 'persona', valor: 'si' }, 100);
  assert.equal(tipos(r, 'ignorado_formato'), 2);
});
