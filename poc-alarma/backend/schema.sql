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
