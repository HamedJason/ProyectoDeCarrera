#!/usr/bin/env bash
#
# Toma UNA foto de la camara por RTSP a traves del tunel y la guarda como JPEG.
# Es la base de la "foto de alarma": el VPS pide el cuadro, el ESP32 solo reenvia.
#
# Uso:  ./foto_camara.sh [archivo.jpg]
#       RTSP_RUTA=stream1 ./foto_camara.sh alta.jpg     (cambia de flujo solo esta vez)
#
# Salida: ruta del archivo en stdout si salio bien; codigo distinto de 0 si no.
#
# Limitacion conocida: ffmpeg recibe la URL con la clave como argumento, y un
# usuario local del VPS podria verla un instante con 'ps'. En un VPS de un solo
# usuario es aceptable; si no, usar MediaMTX con la clave en su archivo de config.

set -uo pipefail
# shellcheck source=comun.sh
. "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

RUTA_FORZADA="${RTSP_RUTA:-}"
cargar_env || exit 2
[ -n "$RUTA_FORZADA" ] && RTSP_RUTA="$RUTA_FORZADA"

[ -n "$CAMARA_USUARIO" ] && [ -n "$CAMARA_CLAVE" ] || { echo "[error] faltan usuario o clave en puente.env" >&2; exit 2; }

destino="${1:-foto_$(date +%Y%m%d_%H%M%S).jpg}"
tmp="$(mktemp "${destino}.XXXXXX")" || exit 1
trap 'rm -f "$tmp"' EXIT

# -frames:v 1: un solo cuadro. -q:v 3: JPEG de buena calidad. Limite de 25 s en total.
if ! timeout 25 ffmpeg -nostdin -loglevel error -rtsp_transport tcp -i "$(url_rtsp)" \
       -frames:v 1 -q:v 3 -f image2 -y "$tmp" 2>&1 | ocultar_clave >&2; then
  :
fi

# Validar: no vacio y cabecera JPEG (FF D8).
if [ ! -s "$tmp" ] || [ "$(head -c2 "$tmp" | od -An -tx1 | tr -d ' \n')" != "ffd8" ]; then
  echo "[error] no se obtuvo una imagen valida (¿tunel caido o clave incorrecta?)" >&2
  exit 1
fi

mv -f "$tmp" "$destino"
trap - EXIT
echo "$destino"
