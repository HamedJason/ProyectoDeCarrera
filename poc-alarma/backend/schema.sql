-- Proyecto de Carrera - Sistema escalable de seguridad residencial
-- Estructura de la base de datos
--
-- Los campos vivienda_id, zona, nodo_id y sensor_id se conservan como texto
-- para no adelantar el diseno relacional definitivo, pero manteniendo desde
-- ahora la jerarquia que caracteriza al proyecto.

-- ============================================================
-- Eventos registrados por los sensores
-- ============================================================
CREATE TABLE IF NOT EXISTS mediciones (
    id               SERIAL PRIMARY KEY,
    vivienda_id      TEXT        NOT NULL,
    zona             TEXT,
    nodo_id          TEXT        NOT NULL,
    sensor_id        TEXT        NOT NULL,
    variable         TEXT        NOT NULL,
    valor            DOUBLE PRECISION NOT NULL,
    unidad           TEXT,
    numero_registro  BIGINT,
    creado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indice para la consulta mas frecuente del frontend, que pide las mediciones
-- mas recientes de una vivienda.
CREATE INDEX IF NOT EXISTS idx_mediciones_vivienda_fecha
    ON mediciones (vivienda_id, creado_en DESC);

-- ============================================================
-- Estado de armado de cada vivienda (RF-11 y RF-13)
-- ============================================================
-- Se persiste en la base de datos y no en memoria, para que el estado
-- sobreviva a un reinicio del servicio. Si el concentrador se reinicia,
-- recupera de aqui si la vivienda quedo armada.
CREATE TABLE IF NOT EXISTS estado_vivienda (
    vivienda_id      TEXT        PRIMARY KEY,
    armado           BOOLEAN     NOT NULL DEFAULT FALSE,
    modo_silencioso  BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Activacion manual de la salida audible, independiente del armado.
    -- Sirve para probar la sirena sin tener que generar un evento real.
    actuador_activo  BOOLEAN     NOT NULL DEFAULT FALSE,
    actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indica que hay una alarma sonando en este momento. La activa el nodo cuando
-- un sensor dispara con el sistema armado, y la apaga la aplicacion, el
-- desarmado o el fin del tiempo de sirena.
-- Se agrega con ALTER para que una base creada antes de este cambio (por
-- ejemplo la de la VPS) se actualice sin perder datos.
ALTER TABLE estado_vivienda
    ADD COLUMN IF NOT EXISTS alarma_activa BOOLEAN NOT NULL DEFAULT FALSE;

-- Texto que explica por que suena la alarma, por ejemplo "Puerta abierta en
-- entrada". Se muestra en la aplicacion y se envia en la notificacion.
ALTER TABLE estado_vivienda
    ADD COLUMN IF NOT EXISTS alarma_motivo TEXT;

-- ============================================================
-- Bitacora de acciones del usuario (RNF-11, trazabilidad)
-- ============================================================
-- Conserva quien realizo cada accion sobre el sistema y en que momento.
-- El campo usuario es texto porque la gestion de cuentas se define en un
-- taller posterior. Mientras tanto identifica el origen de la accion.
CREATE TABLE IF NOT EXISTS acciones (
    id             SERIAL PRIMARY KEY,
    vivienda_id    TEXT        NOT NULL,
    accion         TEXT        NOT NULL,
    valor_anterior TEXT,
    valor_nuevo    TEXT,
    usuario        TEXT        NOT NULL DEFAULT 'residente',
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acciones_vivienda_fecha
    ON acciones (vivienda_id, creado_en DESC);

-- ============================================================
-- Registro de sensores de cada vivienda
-- ============================================================
-- Permite tener muchas puertas, ventanas y detectores de movimiento. El nodo
-- solo reporta contacto (estado_puerta) o movimiento; el residente decide en
-- la aplicacion si un contacto es una puerta o una ventana.
CREATE TABLE IF NOT EXISTS sensores (
    id           SERIAL PRIMARY KEY,
    vivienda_id  TEXT        NOT NULL,
    sensor_id    TEXT        NOT NULL,
    nodo_id      TEXT,
    tipo         TEXT        NOT NULL CHECK (tipo IN ('puerta', 'ventana', 'movimiento')),
    nombre       TEXT        NOT NULL,
    zona         TEXT,
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (vivienda_id, sensor_id)
);

-- Sensor que disparo la alarma en curso, para resaltarlo en la aplicacion.
ALTER TABLE estado_vivienda
    ADD COLUMN IF NOT EXISTS alarma_sensor TEXT;

-- ============================================================
-- Notificaciones push (Web Push)
-- ============================================================
-- Claves VAPID del servidor. Se generan una sola vez al primer arranque y se
-- conservan aqui para que las suscripciones existentes no se invaliden.
CREATE TABLE IF NOT EXISTS ajustes_servidor (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

-- Dispositivos que aceptaron recibir avisos. Cada navegador tiene un endpoint
-- unico que entrega el servicio de push de su plataforma (Apple, Google, etc.).
CREATE TABLE IF NOT EXISTS suscripciones_push (
    id          SERIAL PRIMARY KEY,
    vivienda_id TEXT        NOT NULL,
    endpoint    TEXT        NOT NULL UNIQUE,
    p256dh      TEXT        NOT NULL,
    auth        TEXT        NOT NULL,
    agente      TEXT,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Cuentas, sesiones y viviendas (inicio de sesion y multivivienda)
-- ============================================================
-- Hasta ahora vivienda_id era solo un texto que cualquiera podia consultar.
-- Con estas tablas cada vivienda tiene duenos y miembros, y la aplicacion exige
-- una sesion para ver o cambiar sus datos. Las demas tablas siguen usando
-- vivienda_id como texto, por lo que los datos existentes se conservan.
CREATE TABLE IF NOT EXISTS usuarios (
    id            SERIAL PRIMARY KEY,
    email         TEXT        NOT NULL,
    nombre        TEXT        NOT NULL,
    clave_hash    TEXT        NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ultimo_acceso TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_idx ON usuarios (LOWER(email));

-- Solo se guarda el resumen (SHA-256) del identificador de sesion. Si alguien
-- obtuviera la base de datos no podria usar las sesiones activas.
CREATE TABLE IF NOT EXISTS sesiones (
    id_hash    TEXT        PRIMARY KEY,
    usuario_id INTEGER     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expira_en  TIMESTAMPTZ NOT NULL,
    agente     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones (usuario_id);

-- token_hash es el resumen del token que usan el concentrador y la camara de la
-- vivienda. NULL significa que la vivienda aun usa el DEVICE_TOKEN global.
CREATE TABLE IF NOT EXISTS viviendas (
    id         TEXT        PRIMARY KEY,
    nombre     TEXT        NOT NULL,
    token_hash TEXT,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS viviendas_token_idx ON viviendas (token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS miembros (
    vivienda_id TEXT    NOT NULL REFERENCES viviendas(id) ON DELETE CASCADE,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    rol         TEXT    NOT NULL DEFAULT 'miembro' CHECK (rol IN ('propietario', 'miembro')),
    desde       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vivienda_id, usuario_id)
);

-- Codigos de un solo uso para que otra persona se una a una vivienda, o cree su
-- cuenta cuando el registro abierto esta desactivado.
CREATE TABLE IF NOT EXISTS invitaciones (
    codigo      TEXT        PRIMARY KEY,
    vivienda_id TEXT        NOT NULL REFERENCES viviendas(id) ON DELETE CASCADE,
    creado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expira_en   TIMESTAMPTZ NOT NULL,
    usado_por   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    usado_en    TIMESTAMPTZ
);

-- ============================================================
-- Nodos y registro automatico de sensores
-- ============================================================
-- El concentrador reporta cada pocos segundos los nodos que escucha. Asi la
-- aplicacion sabe si un nodo sigue vivo (RF-25) y los sensores nuevos aparecen
-- solos, sin esperar a que alguien abra la puerta.
CREATE TABLE IF NOT EXISTS nodos (
    vivienda_id  TEXT        NOT NULL,
    nodo_id      TEXT        NOT NULL,
    ultimo_visto TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rssi         INTEGER,
    en_linea     BOOLEAN     NOT NULL DEFAULT TRUE,
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vivienda_id, nodo_id)
);

-- Un sensor creado automaticamente queda "por confirmar" hasta que el
-- residente le pone nombre y tipo. Sigue funcionando mientras tanto.
ALTER TABLE sensores
    ADD COLUMN IF NOT EXISTS confirmado BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================================
-- Camara (ESP32 con OV5640)
-- ============================================================
-- Las imagenes se guardan como archivos en disco, no en la base de datos, para
-- no inflarla. Aqui solo queda el registro de cada una.
CREATE TABLE IF NOT EXISTS camaras (
    vivienda_id  TEXT        NOT NULL,
    camara_id    TEXT        NOT NULL,
    nombre       TEXT,
    ultimo_visto TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vivienda_id, camara_id)
);

CREATE TABLE IF NOT EXISTS tareas_camara (
    id           SERIAL PRIMARY KEY,
    vivienda_id  TEXT        NOT NULL,
    tipo         TEXT        NOT NULL CHECK (tipo IN ('foto', 'vivo')),
    motivo       TEXT,
    sensor_id    TEXT,
    cantidad     INTEGER     NOT NULL DEFAULT 1,
    tomadas      INTEGER     NOT NULL DEFAULT 0,
    usuario      TEXT,
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    iniciada_en  TIMESTAMPTZ,
    terminada_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tareas_camara_pend ON tareas_camara (vivienda_id, creado_en) WHERE terminada_en IS NULL;

CREATE TABLE IF NOT EXISTS fotos (
    id          SERIAL PRIMARY KEY,
    vivienda_id TEXT        NOT NULL,
    camara_id   TEXT,
    tarea_id    INTEGER,
    motivo      TEXT,
    sensor_id   TEXT,
    bytes       INTEGER     NOT NULL,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fotos_vivienda_fecha ON fotos (vivienda_id, creado_en DESC);

-- Sesiones de vista en vivo, para aplicar el tope de minutos por dia (RF-21).
CREATE TABLE IF NOT EXISTS sesiones_vivo (
    id          SERIAL PRIMARY KEY,
    vivienda_id TEXT        NOT NULL,
    usuario     TEXT,
    inicio      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sesiones_vivo_vivienda ON sesiones_vivo (vivienda_id, inicio DESC);

-- Ultima vez que el concentrador de la vivienda consulto al servidor. Sirve para
-- avisar al usuario si el concentrador deja de comunicarse (una alarma que no
-- puede dispararse es peor que una que suena de mas).
ALTER TABLE viviendas ADD COLUMN IF NOT EXISTS hub_visto TIMESTAMPTZ;
ALTER TABLE viviendas ADD COLUMN IF NOT EXISTS hub_alerta BOOLEAN NOT NULL DEFAULT FALSE;

-- Persona que activo las notificaciones en cada dispositivo. Si luego sale de la
-- vivienda, deja de recibirlas.
ALTER TABLE suscripciones_push ADD COLUMN IF NOT EXISTS usuario_id INTEGER;

-- Un mismo telefono puede recibir avisos de varias viviendas: la unicidad pasa
-- de "un endpoint" a "un endpoint por vivienda".
ALTER TABLE suscripciones_push DROP CONSTRAINT IF EXISTS suscripciones_push_endpoint_key;
CREATE UNIQUE INDEX IF NOT EXISTS suscripciones_push_viv_ep ON suscripciones_push (vivienda_id, endpoint);
