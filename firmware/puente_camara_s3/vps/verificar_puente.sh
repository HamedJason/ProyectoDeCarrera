#!/usr/bin/env bash
#
# Verifica el puente de extremo a extremo, desde el VPS:
#   1. handshake reciente de WireGuard
#   2. ping al ESP32 por el tunel
#   3. puertos 554 (RTSP) y 2020 (ONVIF) abiertos a traves del tunel
#   4. ONVIF responde (GetSystemDateAndTime, no requiere clave)
#   5. RTSP entrega video (ffprobe lee codec y resolucion)
#
# Uso:  ./verificar_puente.sh            (necesita puente.env junto al script)
# Salida: una linea PASA/FALLA por prueba y codigo de salida 0 solo si todo pasa.
# La clave de la camara nunca se imprime.

set -uo pipefail
# shellcheck source=comun.sh
. "$(dirname "${BASH_SOURCE[0]}")/comun.sh"
cargar_env || exit 2

OK=0; MAL=0
pasa()  { printf 'PASA   %s\n' "$*"; OK=$((OK+1)); }
falla() { printf 'FALLA  %s\n' "$*"; MAL=$((MAL+1)); }

# 1. Handshake: si es mas viejo de 3 minutos el tunel esta caido o sin keepalive.
if ! command -v wg >/dev/null 2>&1; then
  falla "handshake: no esta instalado 'wg'"
else
  ultimo="$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk 'NR==1{print $2}')"
  if [ -z "${ultimo:-}" ]; then
    falla "handshake: no pude leer ${WG_IF} (necesita root, o la interfaz no existe)"
  elif [ "$ultimo" -eq 0 ]; then
    falla "handshake: el ESP32 nunca se ha conectado"
  else
    edad=$(( $(date +%s) - ultimo ))
    if [ "$edad" -le 180 ]; then pasa "handshake hace ${edad} s"; else falla "handshake hace ${edad} s (> 180 s)"; fi
  fi
fi

# 2. Ping por el tunel.
if ping -c 3 -W 2 "$CAMARA_IP_TUNEL" >/dev/null 2>&1; then
  pasa "ping a ${CAMARA_IP_TUNEL}"
else
  falla "ping a ${CAMARA_IP_TUNEL} (el tunel puede estar caido)"
fi

# 3. Puertos reenviados por 'portmap ... VPN'.
for p in "$RTSP_PUERTO" "$ONVIF_PUERTO"; do
  if puerto_abierto "$CAMARA_IP_TUNEL" "$p"; then
    pasa "TCP ${CAMARA_IP_TUNEL}:${p} abierto"
  else
    falla "TCP ${CAMARA_IP_TUNEL}:${p} cerrado (revisar 'show mappings' en el ESP32 y la IP de la camara)"
  fi
done

# 4. ONVIF: la respuesta de GetSystemDateAndTime no necesita autenticacion.
soap='<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>'
resp="$(curl -sS -m 8 -X POST -H 'Content-Type: application/soap+xml' --data "$soap" \
        "http://${CAMARA_IP_TUNEL}:${ONVIF_PUERTO}/onvif/device_service" 2>&1 || true)"
if printf '%s' "$resp" | grep -q 'GetSystemDateAndTimeResponse'; then
  pasa "ONVIF responde en :${ONVIF_PUERTO}"
else
  falla "ONVIF no responde en :${ONVIF_PUERTO} (¿ONVIF activado en la app Tapo?)"
fi

# 5. RTSP: leer metadatos del video.
if [ -z "$CAMARA_USUARIO" ] || [ -z "$CAMARA_CLAVE" ]; then
  falla "RTSP: faltan CAMARA_USUARIO o CAMARA_CLAVE en puente.env"
elif ! command -v ffprobe >/dev/null 2>&1; then
  falla "RTSP: no esta instalado ffprobe"
else
  salida="$(timeout 20 ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
            -show_entries stream=codec_name,width,height -of csv=p=0 "$(url_rtsp)" 2>&1 | ocultar_clave)"
  if printf '%s' "$salida" | grep -Eq '^[a-z0-9_]+,[0-9]+,[0-9]+'; then
    pasa "RTSP ${RTSP_RUTA}: $(printf '%s' "$salida" | head -n1)"
  else
    falla "RTSP ${RTSP_RUTA}: $(printf '%s' "$salida" | head -n1)"
  fi
fi

echo "----"
echo "Resultado: ${OK} pasan, ${MAL} fallan"
[ "$MAL" -eq 0 ]
