-- Proyecto de Carrera - Sistema escalable de seguridad residencial
-- Taller 5: estructura inicial de la base de datos
--
-- Esta es la version minima requerida por la prueba de concepto. El modelo
-- completo de viviendas, zonas, nodos, sensores, usuarios y evidencia
-- fotografica se desarrolla en talleres posteriores. Aqui se conservan los
-- campos vivienda_id, zona, nodo_id y sensor_id como texto para no adelantar
-- el diseno relacional definitivo, pero manteniendo desde ahora la jerarquia
-- que caracteriza al proyecto.

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
