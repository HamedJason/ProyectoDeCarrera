#!/usr/bin/env bash
#
# Configura WireGuard en el VPS para el puente de la camara (ESP32-S3).
#
# Que hace:
#   1. Comprueba que la subred del tunel y la del AP del ESP32 no choquen con
#      ninguna ruta del servidor (incluidas las redes de Docker).
#   2. Instala wireguard-tools, ffmpeg e iperf3 si faltan.
#   3. Genera las claves (servidor, ESP32 y clave precompartida) en /etc/wireguard.
#   4. Crea /etc/wireguard/wg0.conf y levanta el servicio.
#   5. Escribe en un archivo con permisos 600 el comando "set_vpn" que se pega
#      en la consola del ESP32. Las claves NUNCA se imprimen en pantalla.
#
# Uso (como root, en el VPS):
#   sudo ./instalar_wireguard.sh --ip-publica 203.0.113.10
#   sudo ./instalar_wireguard.sh --ip-publica 203.0.113.10 --force   # regenera todo
#   ./instalar_wireguard.sh --dry-run --dir /tmp/wgprueba            # solo genera archivos
#
# Variables (todas opcionales): WG_IF WG_PORT WG_SUBRED WG_MTU SUBRED_AP SALIDA
# (RUTAS_ARCHIVO: solo para pruebas; usa ese archivo en lugar de "ip route")
#
# El script es idempotente: si wg0.conf ya existe no lo toca salvo con --force.

set -euo pipefail
umask 077

WG_IF="${WG_IF:-wg0}"
WG_PORT="${WG_PORT:-51820}"
WG_SUBRED="${WG_SUBRED:-10.8.0}"        # tres primeros octetos; la mascara es /24
WG_MTU="${WG_MTU:-1380}"                # igual en el ESP32 (-M). Bajar si el trafico se atasca.
SUBRED_AP="${SUBRED_AP:-192.168.4.0/24}" # red del AP del ESP32 (la de la camara)
WG_DIR="${WG_DIR:-/etc/wireguard}"
SALIDA="${SALIDA:-/root/puente_esp32_comandos.txt}"
IP_PUBLICA="${IP_PUBLICA:-}"
DRY_RUN=0
FORCE=0

uso() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ip-publica) IP_PUBLICA="${2:?falta la IP publica}"; shift 2 ;;
    --dir) WG_DIR="${2:?falta el directorio}"; shift 2 ;;
    --salida) SALIDA="${2:?falta la ruta}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) uso; exit 0 ;;
    *) echo "Argumento desconocido: $1" >&2; uso >&2; exit 2 ;;
  esac
done

IP_SERVIDOR="${WG_SUBRED}.1"
IP_ESP32="${WG_SUBRED}.2"
SUBRED_TUNEL="${WG_SUBRED}.0/24"

aviso() { printf '[aviso] %s\n' "$*" >&2; }
paso()  { printf '[paso] %s\n' "$*"; }
fallo() { printf '[error] %s\n' "$*" >&2; exit 1; }

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  fallo "ejecuta como root (sudo), o usa --dry-run para probar sin tocar el sistema"
fi

# Subredes
# Rutas del servidor. RUTAS_ARCHIVO permite probar el script con rutas de ejemplo.
rutas_actuales() {
  if [ -n "${RUTAS_ARCHIVO:-}" ]; then cat "$RUTAS_ARCHIVO"; else ip -4 route show; fi
}

comprobar_subredes() {
  if [ -z "${RUTAS_ARCHIVO:-}" ]; then
    command -v ip >/dev/null 2>&1 || { aviso "no hay 'ip'; omito la comprobacion de subredes"; return 0; }
  fi
  command -v python3 >/dev/null 2>&1 || { aviso "no hay python3; omito la comprobacion de subredes"; return 0; }
  # Rutas actuales, sin las del propio tunel (para poder volver a ejecutar el script).
  rutas_actuales | grep -v " dev ${WG_IF}\b" | python3 -c '
import ipaddress, sys
candidatas = [ipaddress.ip_network(c) for c in sys.argv[1:]]
malas = []
for linea in sys.stdin:
    campo = linea.split()[0] if linea.split() else ""
    if "/" not in campo:
        continue
    try:
        red = ipaddress.ip_network(campo, strict=False)
    except ValueError:
        continue
    for c in candidatas:
        if c.overlaps(red):
            malas.append("%s choca con la ruta %s" % (c, red))
if malas:
    print("\n".join(malas))
    sys.exit(1)
' "$SUBRED_TUNEL" "$SUBRED_AP" || fallo "choque de subredes (ver arriba). Cambia WG_SUBRED o SUBRED_AP y repite."
}
paso "Comprobando que ${SUBRED_TUNEL} y ${SUBRED_AP} estan libres"
comprobar_subredes

# Paquetes
if [ "$DRY_RUN" -eq 0 ]; then
  faltan=()
  command -v wg >/dev/null 2>&1      || faltan+=(wireguard-tools)
  command -v ffmpeg >/dev/null 2>&1  || faltan+=(ffmpeg)
  command -v iperf3 >/dev/null 2>&1  || faltan+=(iperf3)
  if [ "${#faltan[@]}" -gt 0 ]; then
    paso "Instalando: ${faltan[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${faltan[@]}"
  fi
fi
command -v wg >/dev/null 2>&1 || fallo "falta el comando 'wg' (paquete wireguard-tools)"

# Claves
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"
CONF="${WG_DIR}/${WG_IF}.conf"

if [ -e "$CONF" ] && [ "$FORCE" -eq 0 ]; then
  paso "${CONF} ya existe; no lo modifico (usa --force para regenerar todo)"
  exit 0
fi

K_SRV="${WG_DIR}/${WG_IF}_servidor.key"
K_ESP="${WG_DIR}/${WG_IF}_esp32.key"
K_PSK="${WG_DIR}/${WG_IF}_esp32.psk"

generar() { # $1 = archivo, $2.. = comando que escribe la clave por stdout
  local f="$1"; shift
  if [ "$FORCE" -eq 1 ] || [ ! -s "$f" ]; then
    "$@" > "$f"
  fi
  chmod 600 "$f"
}
paso "Generando claves en ${WG_DIR}"
generar "$K_SRV" wg genkey
generar "$K_ESP" wg genkey
generar "$K_PSK" wg genpsk
PUB_SRV="$(wg pubkey < "$K_SRV")"
PUB_ESP="$(wg pubkey < "$K_ESP")"

# wg0.conf
paso "Escribiendo ${CONF}"
cat > "$CONF" <<EOF
# Generado por instalar_wireguard.sh. No subir este archivo a ningun repositorio.
[Interface]
Address = ${IP_SERVIDOR}/24
ListenPort = ${WG_PORT}
PrivateKey = $(cat "$K_SRV")
MTU = ${WG_MTU}

# ESP32-S3 (puente de la camara). El ESP32 inicia la conexion, asi que aqui no
# hace falta Endpoint. AllowedIPs incluye la red del AP para que el servidor
# sepa devolver paquetes hacia la camara.
[Peer]
PublicKey = ${PUB_ESP}
PresharedKey = $(cat "$K_PSK")
AllowedIPs = ${IP_ESP32}/32, ${SUBRED_AP}
EOF
chmod 600 "$CONF"

# Comando para el ESP32
if [ -z "$IP_PUBLICA" ]; then
  if command -v ip >/dev/null 2>&1; then
    IP_PUBLICA="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
  fi
  aviso "no indicaste --ip-publica; uso la detectada (${IP_PUBLICA:-ninguna}). Verificala."
fi
[ -n "$IP_PUBLICA" ] || IP_PUBLICA="IP_PUBLICA_DEL_VPS"

{
  echo "# Pegar en la consola del ESP32 (serie o remota). Contiene claves: borrar este archivo despues."
  echo "set_vpn $(cat "$K_ESP") ${PUB_SRV} ${IP_PUBLICA} ${IP_ESP32} -k $(cat "$K_PSK") -p ${WG_PORT} -a 25 -M ${WG_MTU} -R 0 -e 1"
} > "$SALIDA"
chmod 600 "$SALIDA"
paso "Comando para el ESP32 guardado en ${SALIDA} (permisos 600)"

# Servicio y firewall
if [ "$DRY_RUN" -eq 0 ]; then
  if systemctl is-active --quiet "wg-quick@${WG_IF}"; then
    paso "Reiniciando wg-quick@${WG_IF}"
    systemctl restart "wg-quick@${WG_IF}"
  else
    paso "Activando wg-quick@${WG_IF}"
    systemctl enable --now "wg-quick@${WG_IF}"
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    paso "Abriendo ${WG_PORT}/udp en ufw"
    ufw allow "${WG_PORT}/udp" >/dev/null
  fi
  echo
  aviso "Falta abrir ${WG_PORT}/UDP en el firewall del panel de OVH (Edge Network Firewall / Security Group), si lo usas."
  echo "Siguiente paso: pega el comando de ${SALIDA} en el ESP32 y ejecuta ./verificar_puente.sh"
else
  paso "Modo prueba: no se instalo nada ni se levanto el servicio"
fi
