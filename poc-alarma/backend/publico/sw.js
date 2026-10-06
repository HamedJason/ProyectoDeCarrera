/*
 * Service worker de la aplicacion.
 * Su unica funcion es recibir las notificaciones push del servidor y mostrarlas,
 * aunque la aplicacion este cerrada. No guarda nada en cache.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (evento) => {
  let datos = {};
  try { datos = evento.data ? evento.data.json() : {}; } catch (e) { datos = { cuerpo: evento.data ? evento.data.text() : '' }; }
  const titulo = datos.titulo || 'Seguridad residencial';
  const opciones = {
    body: datos.cuerpo || '',
    icon: 'icono.png',
    badge: 'icono.png',
    tag: datos.etiqueta || 'alarma',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300, 150, 300],
    data: { url: datos.url || '/' }
  };
  // iOS exige mostrar siempre una notificacion al recibir un push
  const tareas = [self.registration.showNotification(titulo, opciones)];
  // Avisa al servidor que el aviso llego, para medir la demora de entrega
  if (datos.id) {
    tareas.push(fetch('/push/recibido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: datos.id })
    }).catch(() => {}));
  }
  evento.waitUntil(Promise.all(tareas));
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = (evento.notification.data && evento.notification.data.url) || '/';
  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      for (const v of ventanas) {
        if ('focus' in v) return v.focus();
      }
      return self.clients.openWindow(destino);
    })
  );
});
