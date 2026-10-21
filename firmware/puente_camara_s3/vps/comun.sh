#!/usr/bin/env bash
# Funciones compartidas por los scripts del puente. Se usa con: . "$(dirname "$0")/comun.sh"
# No ejecutar directamente.

# Lee SOLO las claves conocidas de puente.env, como texto. No ejecuta el archivo,
# asi un valor con $, `, ; o espacios no puede correr comandos.
# shellcheck disable=SC2034  # las variables las usan los scripts que cargan este archivo
cargar_env() {
  local archivo="${PUENTE_ENV:-$(dirname "${BASH_SOURCE[0]}")/puente.env}"
  [ -r "$archivo" ] || { echo "[error] no encuentro $archivo (copia puente.env.ejemplo)" >&2; return 1; }
  CAMARA_IP_TUNEL="10.8.0.2"; CAMARA_USUARIO=""; CAMARA_CLAVE=""
  RTSP_PUERTO="554"; ONVIF_PUERTO="2020"; RTSP_RUTA="stream2"; WG_IF="wg0"
  local linea clave valor
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%$'\r'}"
    case "$linea" in ''|'#'*) continue ;; esac
    clave="${linea%%=*}"; valor="${linea#*=}"
    case "$clave" in
      CAMARA_IP_TUNEL|CAMARA_USUARIO|CAMARA_CLAVE|RTSP_PUERTO|ONVIF_PUERTO|RTSP_RUTA|WG_IF)
        printf -v "$clave" '%s' "$valor" ;;
    esac
  done < "$archivo"
}

# Codifica un texto para usarlo dentro de una URL (usuario y clave con simbolos).
url_codificar() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

# URL RTSP completa (con credenciales). Usar solo para pasarla a ffmpeg/ffprobe.
url_rtsp() {
  local u c
  u="$(url_codificar "$CAMARA_USUARIO")"; c="$(url_codificar "$CAMARA_CLAVE")"
  printf 'rtsp://%s:%s@%s:%s/%s' "$u" "$c" "$CAMARA_IP_TUNEL" "$RTSP_PUERTO" "$RTSP_RUTA"
}

# Filtro para que la clave no aparezca en pantalla ni en los registros.
ocultar_clave() {
  if [ -n "${CAMARA_CLAVE:-}" ]; then
    local c; c="$(url_codificar "$CAMARA_CLAVE")"
    python3 -c '
import sys
datos = sys.stdin.read()
for s in sys.argv[1:]:
    if s:
        datos = datos.replace(s, "***")
sys.stdout.write(datos)
' "$CAMARA_CLAVE" "$c"
  else
    cat
  fi
}

# Conexion TCP de prueba con tiempo maximo. Uso: puerto_abierto IP PUERTO
puerto_abierto() {
  timeout 5 bash -c 'exec 3<>/dev/tcp/$1/$2' _ "$1" "$2" 2>/dev/null
}
