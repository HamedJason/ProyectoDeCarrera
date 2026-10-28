// Une las lecturas de los sensores con las acciones del usuario en una sola linea de tiempo

const TEXTOS = {
  armar:               ['Casa armada', ''],
  desarmar:            ['Casa desarmada', ''],
  alarma_activada:     ['Alarma activada', 'alarma'],
  alarma_terminada:    ['Alarma terminada por tiempo', ''],
  apagar_alarma:       ['Alarma apagada desde la app', ''],
  alarma_silenciosa:   ['Alarma en modo silencioso, sin sirena', 'alarma'],
  vista_en_vivo:       ['Vista en vivo de la cámara', ''],
  foto_eliminada:      ['Foto eliminada', ''],
  token_regenerado:    ['Token de dispositivos regenerado', ''],
  miembro_eliminado:   ['Miembro eliminado de la vivienda', ''],
  salio_de_vivienda:   ['Una persona salió de la vivienda', '']
};
const CON_NOMBRE = { sensor_agregado: 'Sensor agregado', sensor_editado: 'Sensor editado', sensor_eliminado: 'Sensor eliminado' };

export function construirHitos(mediciones, acciones, sensores) {
  const hitos = [];
  const porId = {};
  for (const s of sensores) porId[s.sensor_id] = s;

  for (const m of mediciones) {
    const zona = m.zona ? ' en ' + m.zona : '';
    const sen = porId[m.sensor_id];
    if (m.variable === 'estado_puerta') {
      const abierta = Number(m.valor) === 1;
      const titulo = sen ? sen.nombre + (abierta ? ' abierta' : ' cerrada') : (abierta ? 'Puerta abierta' : 'Puerta cerrada');
      hitos.push({ t: m.creado_en, clase: abierta ? 'actividad' : 'cerrada', titulo, detalle: sen ? '' : zona });
    } else if (m.variable === 'movimiento') {
      hitos.push({ t: m.creado_en, clase: 'actividad', titulo: 'Movimiento detectado', detalle: sen ? ' · ' + sen.nombre : zona });
    } else {
      hitos.push({ t: m.creado_en, clase: '', titulo: m.variable + ' ' + m.valor, detalle: zona });
    }
  }

  for (const a of acciones) {
    let titulo, clase = '';
    if (TEXTOS[a.accion]) {
      [titulo, clase] = TEXTOS[a.accion];
    } else if (a.accion === 'modo_silencioso') {
      titulo = a.valor_nuevo === 'true' ? 'Modo silencioso activado' : 'Modo silencioso desactivado';
    } else if (a.accion === 'salida_audible') {
      titulo = a.valor_nuevo === 'true' ? 'Prueba de sirena encendida' : 'Prueba de sirena apagada';
    } else if (CON_NOMBRE[a.accion]) {
      titulo = CON_NOMBRE[a.accion] + (a.valor_nuevo ? ': ' + a.valor_nuevo : '');
    } else {
      titulo = a.accion;
    }
    hitos.push({ t: a.creado_en, clase, titulo, detalle: a.usuario && a.usuario !== 'residente' ? ' · ' + a.usuario : '' });
  }

  return hitos.sort((x, y) => new Date(y.t) - new Date(x.t)).slice(0, 40);
}
