# Frontend web de Sentinel Home (Vue 3 + Vite)

Aplicación web (PWA) del sistema de seguridad residencial. Antes era un solo `index.html` de 2,500 líneas;
ahora está dividida en componentes de Vue 3, almacenes de estado y utilidades, y se compila con Vite.

## Uso

```bash
cd frontend-web
npm install
npm run dev        # servidor de desarrollo en http://localhost:5173 (las llamadas a la API van a localhost:3000)
npm run build      # compila y escribe el resultado en ../backend/publico
```

El backend sirve la carpeta `backend/publico`, así que **después de cambiar el frontend hay que ejecutar `npm run build`
y subir también `backend/publico`**. El despliegue con Docker no necesita Node para el frontend.

## Estructura

```
frontend-web/
├─ index.html              página base (metadatos de la PWA)
├─ vite.config.js          compila a ../backend/publico y define el proxy de desarrollo
├─ public/                 se copia tal cual: manifest.json, sw.js (notificaciones push), icono y tipografía
└─ src/
   ├─ main.js              arranque y carga de los estilos
   ├─ App.vue              raíz: acceso o aplicación
   ├─ api/cliente.js       fetch con tiempo límite, manejo de sesión caducada y mensajes de error
   ├─ stores/              estado compartido (módulos con refs de Vue)
   │  ├─ sesion.js         usuario, vivienda actual y pantalla
   │  ├─ casa.js           estado de la alarma, sensores, nodos, historial y actualización periódica
   │  ├─ camara.js         cámara, detección, eventos y fotos
   │  ├─ avisos.js         push, sonido, vibración y parpadeo del título
   │  ├─ cuenta.js         iniciar/cerrar sesión, viviendas, invitaciones y token de dispositivos
   │  ├─ conexion.js       aviso de fallo de comunicación
   │  └─ ui.js             qué hojas (diálogos) están abiertas
   ├─ utils/               formato de fechas, historial y agrupación de eventos de la cámara
   ├─ components/          pantallas y piezas visuales (ver abajo)
   └─ estilos/             hojas de estilo por área (base, panel, tarjetas, ilustraciones, diálogos, cámara...)
```

Componentes principales: `AccesoView`, `PanelPrincipal`, `BarraSuperior`, `EscenaEstado`, `CamaraMini`,
`GrupoSensores` / `TarjetaSensor` / `IlustracionSensor`, `TarjetaSirena`, `SeccionCamara`, `AjustesLista`,
`HistorialLista` y los diálogos `DialogoSensor`, `DialogoCasas`, `DialogoGestion`, `DialogoFoto` y `DialogoVivo`
(todos sobre `Hoja`, que envuelve a `<dialog>`).
