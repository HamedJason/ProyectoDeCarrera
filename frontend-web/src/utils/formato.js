// Formato de fechas y tiempos para mostrar en pantalla

export function formatearFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return 'Hoy ' + hora;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) + ' ' + hora;
}

export function hace(iso) {
  if (!iso) return '';
  const seg = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (seg < 60) return 'hace ' + seg + ' s';
  if (seg < 3600) return 'hace ' + Math.floor(seg / 60) + ' min';
  if (seg < 86400) return 'hace ' + Math.floor(seg / 3600) + ' h';
  return 'hace ' + Math.floor(seg / 86400) + ' días';
}

export function formatoMinSeg(seg) {
  seg = Math.max(0, Math.round(seg));
  return Math.floor(seg / 60) + ':' + String(seg % 60).padStart(2, '0');
}

export function horaActual() {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function base64AUint8(base64) {
  const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
  const bin = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
