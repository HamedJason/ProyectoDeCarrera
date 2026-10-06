-- Consultas de la prueba de concepto
-- Estas son las consultas que utiliza el backend y las que sirven como
-- evidencia de recuperacion de informacion para el taller.

-- 1) Consulta principal: recuperar las mediciones mas recientes de una vivienda.
--    Es la que responde GET /mediciones y la que alimenta la lista del frontend.
SELECT id,
       vivienda_id,
       zona,
       nodo_id,
       sensor_id,
       variable,
       valor,
       unidad,
       numero_registro,
       creado_en
FROM mediciones
WHERE vivienda_id = 'casa-001'
ORDER BY creado_en DESC
LIMIT 50;

-- 2) Dato mas reciente, usado por GET /mediciones/ultima
SELECT *
FROM mediciones
WHERE vivienda_id = 'casa-001'
ORDER BY creado_en DESC
LIMIT 1;

-- 3) Conteo total de registros, util para comprobar el minimo de diez
SELECT COUNT(*) AS total_registros
FROM mediciones;

-- 4) Resumen por estado, util para el reporte de pruebas
SELECT valor,
       CASE WHEN valor = 1 THEN 'abierta' ELSE 'cerrada' END AS interpretacion,
       COUNT(*) AS veces
FROM mediciones
WHERE vivienda_id = 'casa-001'
GROUP BY valor
ORDER BY valor;
