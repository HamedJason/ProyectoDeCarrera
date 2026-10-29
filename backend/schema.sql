-- Esquema de la base de datos de Sentinel Home.
-- vivienda_id, zona, nodo_id y sensor_id son texto para no adelantar el diseno relacional
-- definitivo, pero conservan desde ahora la jerarquia del proyecto.

-- Eventos registrados por los sensores
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

-- Indice para la consulta mas frecuente del frontend: las mediciones mas recientes de una vivienda.
CREATE INDEX IF NOT EXISTS idx_mediciones_vivienda_fecha
    ON mediciones (vivienda_id, creado_en DESC);

-- Estado de armado de cada vivienda (RF-11 y RF-13). Se guarda en la base para sobrevivir a un
-- reinicio del servicio; el concentrador recupera de aqui si quedo armada.
CREATE TABLE IF NOT EXISTS estado_vivienda (
    vivienda_id      TEXT        PRIMARY KEY,
    armado           BOOLEAN     NOT NULL DEFAULT FALSE,
    modo_silencioso  BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Activacion manual de la salida audible, independiente del armado; sirve para probar la sirena.
    actuador_activo  BOOLEAN     NOT NULL DEFAULT FALSE,
    actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hay una alarma sonando: la activa el nodo cuando un sensor dispara con el sistema armado y la apaga la
-- aplicacion, el desarmado o el fin del tiempo de sirena. Se agrega con ALTER para actualizar bases ya creadas.
ALTER TABLE estado_vivienda
    ADD COLUMN IF NOT EXISTS alarma_activa BOOLEAN NOT NULL DEFAULT FALSE;

-- Motivo por el que suena la alarma (por ejemplo "Puerta abierta en entrada"); se muestra en la app y en la notificacion.
ALTER TABLE estado_vivienda
    ADD COLUMN IF NOT EXISTS alarma_motivo TEXT;

-- Bitacora de acciones del usuario (RNF-11): quien hizo cada cambio y cuando.
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

-- Registro de sensores de cada vivienda. El nodo solo reporta contacto (estado_puerta) o movimiento;
-- el residente decide en la aplicacion si un contacto es puerta o ventana.
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

-- Notificaciones push (Web Push). Claves VAPID del servidor: se generan una vez y se conservan para no invalidar las suscripciones.
CREATE TABLE IF NOT EXISTS ajustes_servidor (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

-- Dispositivos que aceptaron avisos; cada navegador tiene un endpoint unico que entrega el servicio de push de su plataforma.
CREATE TABLE IF NOT EXISTS suscripciones_push (
    id          SERIAL PRIMARY KEY,
    vivienda_id TEXT        NOT NULL,
    endpoint    TEXT        NOT NULL UNIQUE,
    p256dh      TEXT        NOT NULL,
    auth        TEXT        NOT NULL,
    agente      TEXT,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cuentas, sesiones y viviendas. Las demas tablas siguen usando vivienda_id como texto, asi que los datos existentes se conservan.
CREATE TABLE IF NOT EXISTS usuarios (
    id            SERIAL PRIMARY KEY,
    email         TEXT        NOT NULL,
    nombre        TEXT        NOT NULL,
    clave_hash    TEXT        NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ultimo_acceso TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_idx ON usuarios (LOWER(email));

-- Solo se guarda el resumen (SHA-256) del id de sesion: con la base filtrada no se podrian usar las sesiones activas.
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

-- Codigos de un solo uso para unirse a una vivienda o crear cuenta cuando el registro abierto esta desactivado.
CREATE TABLE IF NOT EXISTS invitaciones (
    codigo      TEXT        PRIMARY KEY,
    vivienda_id TEXT        NOT NULL REFERENCES viviendas(id) ON DELETE CASCADE,
    creado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expira_en   TIMESTAMPTZ NOT NULL,
    usado_por   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    usado_en    TIMESTAMPTZ
);

-- Nodos y registro automatico de sensores: el concentrador reporta los nodos que escucha, asi la app sabe si
-- siguen vivos (RF-25) y los sensores nuevos aparecen solos.
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

-- Camara (ESP32 con OV5640). Las imagenes son archivos en disco, no en la base; aqui solo queda el registro de cada una.
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

-- Eventos de la camara (personas y movimiento por ONVIF). Cada cambio real queda registrado; "alerta" indica
-- si llego a avisar al residente (depende del cooldown, del armado y de la politica configurada).
CREATE TABLE IF NOT EXISTS eventos_camara (
    id          SERIAL PRIMARY KEY,
    vivienda_id TEXT        NOT NULL,
    camara_id   TEXT        NOT NULL,
    detector    TEXT        NOT NULL CHECK (detector IN ('persona', 'movimiento')),
    valor       BOOLEAN     NOT NULL,
    transicion  TEXT        NOT NULL CHECK (transicion IN ('subida', 'bajada')),
    topic       TEXT,
    regla       TEXT,
    fuente      TEXT,
    utc_camara  TIMESTAMPTZ,
    alerta      BOOLEAN     NOT NULL DEFAULT FALSE,
    nota        TEXT,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eventos_camara_vivienda_fecha ON eventos_camara (vivienda_id, creado_en DESC);
