#!/usr/bin/env bash
#
# Mide si el puente aguanta el video: latencia/perdida del tunel y caudal real
# del flujo RTSP (copia sin recodificar). Sirve para decidir si se usa stream2
# o se intenta stream1. No hace falta iperf3 en el ESP32.
#
# Uso:  ./medir_rendimiento.sh [segundos]     (por defecto 30)
#       RTSP_RUTA=stream1 ./medir_rendimiento.sh 60
#
# Interpretacion sugerida (criterio de aceptacion, ajustable):
#   - perdida de ping < 2 %
#   - 0 lineas de error/corrupcion en el flujo
#   - caudal medido >= 90 % del caudal que la camara anuncia
# Medir con la camara en reposo y tambien con movimiento delante del lente.

set -uo pipefail
# shellcheck source=comun.sh
. "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

RUTA_FORZADA="${RTSP_RUTA:-}"
cargar_env || exit 2
[ -n "$RUTA_FORZADA" ] && RTSP_RUTA="$RUTA_FORZADA"

D="${1:-30}"
case "$D" in ''|*[!0-9]*) echo "[error] los segundos deben ser un entero" >&2; exit 2 ;; esac
[ -n "$CAMARA_USUARIO" ] && [ -n "$CAMARA_CLAVE" ] || { echo "[error] faltan usuario o clave en puente.env" >&2; exit 2; }

echo "== Tunel: ${D} pings a ${CAMARA_IP_TUNEL}"
ping -c "$D" -i 1 -W 2 "$CAMARA_IP_TUNEL" 2>&1 | tail -n 3

echo
echo "== Flujo ${RTSP_RUTA}: ${D} s copiados sin recodificar"
inicio="$(date +%s.%N)"
registro="$(timeout $((D + 20)) ffmpeg -nostdin -hide_banner -loglevel info -stats \
              -rtsp_transport tcp -i "$(url_rtsp)" -t "$D" -c copy -f null - 2>&1 | ocultar_clave)"
fin="$(date +%s.%N)"

# ffmpeg resume al final: "video:1234kB audio:56kB ..." (kB = KiB).
resumen="$(printf '%s\n' "$registro" | grep -E 'video:[0-9]+' | tail -n1)"
errores="$(printf '%s\n' "$registro" | grep -Eic 'error|corrupt|missed|discarding|timed out|invalid' || true)"

if [ -z "$resumen" ]; then
  echo "No se pudo leer el flujo. Ultimas lineas:"
  printf '%s\n' "$registro" | tail -n 5
  exit 1
fi

v="$(printf '%s' "$resumen" | sed -n 's/.*video:\([0-9]*\)KiB.*/\1/p;s/.*video:\([0-9]*\)kB.*/\1/p' | head -n1)"
a="$(printf '%s' "$resumen" | sed -n 's/.*audio:\([0-9]*\)KiB.*/\1/p;s/.*audio:\([0-9]*\)kB.*/\1/p' | head -n1)"
v="${v:-0}"; a="${a:-0}"

awk -v v="$v" -v a="$a" -v t0="$inicio" -v t1="$fin" -v d="$D" -v e="$errores" 'BEGIN {
  real = t1 - t0
  kib = v + a
  mbps = (kib * 1024 * 8) / real / 1000000
  printf "Datos recibidos : %d KiB (video %d + audio %d)\n", kib, v, a
  printf "Tiempo real     : %.1f s (pedidos %d s)\n", real, d
  printf "Caudal efectivo : %.2f Mbit/s\n", mbps
  printf "Lineas de error : %d\n", e
}'
echo
echo "Compara el caudal efectivo con el que anuncia la camara (app Tapo > calidad de video)."
