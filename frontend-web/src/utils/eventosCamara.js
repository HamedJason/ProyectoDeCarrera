// Cada paso frente a la camara genera varios eventos seguidos del mismo tipo: se agrupan los que
// ocurren con menos de un minuto de diferencia, y solo se cuentan las "subidas" (el inicio de cada deteccion).
export function agruparEventos(lista) {
  const grupos = [];
  for (const e of lista) {
    if (e.transicion !== 'subida') continue;
    const g = grupos[grupos.length - 1];
    if (g && g.detector === e.detector && new Date(g.masAntiguo) - new Date(e.creado_en) < 60000) {
      g.n++; g.masAntiguo = e.creado_en;
      if (e.alerta) { g.alerta = true; g.nota = e.nota === 'activo la alarma' || g.nota === 'activo la alarma' ? 'activo la alarma' : g.nota; }
    } else {
      grupos.push({ detector: e.detector, t: e.creado_en, masAntiguo: e.creado_en, n: 1, alerta: !!e.alerta, nota: e.nota || null });
    }
  }
  return grupos;
}

const NOTAS = {
  'sistema desarmado': 'Casa desarmada',
  'solo registrado por la politica': 'Solo registrado',
  'retardo de salida': 'Retardo de salida',
  'ya habia una alarma activa': 'Ya sonaba la alarma'
};

export function etiquetaEvento(g) {
  if (g.nota === 'activo la alarma') return ['Activó la alarma', 'alarma'];
  if (g.alerta) return ['Avisó', 'avisado'];
  return [NOTAS[g.nota] || 'Solo registrado', ''];
}
