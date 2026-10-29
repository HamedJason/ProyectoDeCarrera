#!/usr/bin/env bash
#
# Pruebas que NO necesitan hardware ni VPS. Comprueban los scripts del modulo:
#   - sintaxis (bash -n) y shellcheck
#   - que no haya claves reales en el modulo
#   - instalar_wireguard.sh en --dry-run con un 'wg' simulado: genera wg0.conf y
#     el comando del ESP32 con la forma correcta y permisos 600
#   - el lector de puente.env trata los valores como texto (no ejecuta nada)
#   - la codificacion de la clave en la URL RTSP y su ocultamiento en la salida
#   - verificar_puente.sh sin tunel: debe FALLAR de forma ordenada, sin imprimir la clave
#
# Limite: el 'wg' simulado no produce claves X25519 validas. Esta prueba valida
# la logica de los scripts, no el cifrado ni la conectividad real.
#
# Uso: ./prueba_estatica.sh        Codigo de salida 0 si todo pasa.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OK=0; MAL=0
pasa()  { printf 'PASA   %s\n' "$*"; OK=$((OK+1)); }
falla() { printf 'FALLA  %s\n' "$*"; MAL=$((MAL+1)); }
chequear() { local d="$1"; shift; if "$@"; then pasa "$d"; else falla "$d"; fi; }

SCRIPTS=("$RAIZ"/vps/*.sh "$RAIZ"/pruebas/*.sh)

# Sintaxis
for s in "${SCRIPTS[@]}"; do
  chequear "bash -n $(basename "$s")" bash -n "$s"
done

# Shellcheck (si esta instalado)
if command -v shellcheck >/dev/null 2>&1; then
  for s in "${SCRIPTS[@]}"; do
    chequear "shellcheck $(basename "$s")" shellcheck -x -S warning "$s"
  done
else
  echo "OMITE  shellcheck no esta instalado"
fi

# Sin claves reales en el modulo (WireGuard: 43 caracteres base64 + '=')
if grep -RIEn --exclude=prueba_estatica.sh '[A-Za-z0-9+/]{43}=' "$RAIZ" >/dev/null 2>&1; then
  falla "hay una cadena con forma de clave WireGuard dentro del modulo"
else
  pasa "no hay claves WireGuard en el modulo"
fi
[ ! -e "$RAIZ/vps/puente.env" ] && pasa "no hay puente.env en el modulo" || falla "puente.env no debe estar en el repositorio"

# instalar_wireguard.sh en --dry-run con 'wg' simulado
mkdir -p "$TMP/bin"
cat > "$TMP/bin/wg" <<'EOF'
#!/usr/bin/env bash
# wg simulado: solo para probar la logica del script.
case "$1" in
  genkey|genpsk) head -c 32 /dev/urandom | base64 ;;
  pubkey) { read -r k; printf '%s' "$k" | sha256sum | head -c 32 | base64; } ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/wg"

printf 'default via 203.0.113.1 dev eth0\n203.0.113.0/24 dev eth0 src 203.0.113.10\n172.17.0.0/16 dev docker0\n' > "$TMP/rutas_limpias"
printf 'default via 203.0.113.1 dev eth0\n10.8.0.0/16 dev br-abc123\n' > "$TMP/rutas_choque"
export RUTAS_ARCHIVO="$TMP/rutas_limpias"
if PATH="$TMP/bin:$PATH" bash "$RAIZ/vps/instalar_wireguard.sh" --dry-run --dir "$TMP/wg" \
     --salida "$TMP/comandos.txt" --ip-publica 203.0.113.10 >"$TMP/inst.log" 2>&1; then
  pasa "instalar_wireguard.sh --dry-run termina bien"
else
  falla "instalar_wireguard.sh --dry-run fallo: $(tail -n 3 "$TMP/inst.log" | tr '\n' ' ')"
fi
CONF="$TMP/wg/wg0.conf"
chequear "wg0.conf existe con permisos 600"      test "$(stat -c %a "$CONF" 2>/dev/null)" = "600"
chequear "wg0.conf: Address 10.8.0.1/24"          grep -q '^Address = 10.8.0.1/24$' "$CONF"
chequear "wg0.conf: ListenPort 51820"             grep -q '^ListenPort = 51820$' "$CONF"
chequear "wg0.conf: AllowedIPs incluye tunel y AP" grep -q '^AllowedIPs = 10.8.0.2/32, 192.168.4.0/24$' "$CONF"
chequear "wg0.conf: MTU 1380"                     grep -q '^MTU = 1380$' "$CONF"
chequear "comando ESP32 con permisos 600"         test "$(stat -c %a "$TMP/comandos.txt" 2>/dev/null)" = "600"
chequear "comando ESP32 tiene la forma set_vpn"   grep -Eq '^set_vpn [^ ]+ [^ ]+ 203\.0\.113\.10 10\.8\.0\.2 -k [^ ]+ -p 51820 -a 25 -M 1380 -R 0 -e 1$' "$TMP/comandos.txt"
# Las claves no deben salir por pantalla
CLAVE_ESP="$(cat "$TMP/wg/wg0_esp32.key" 2>/dev/null)"
if [ -n "$CLAVE_ESP" ] && grep -qF "$CLAVE_ESP" "$TMP/inst.log"; then falla "el instalador imprimio una clave privada"; else pasa "el instalador no imprime claves"; fi

# Segunda ejecucion: no debe regenerar nada
cp "$CONF" "$TMP/conf_antes"
PATH="$TMP/bin:$PATH" bash "$RAIZ/vps/instalar_wireguard.sh" --dry-run --dir "$TMP/wg" --salida "$TMP/c2.txt" >/dev/null 2>&1
chequear "idempotente: segunda ejecucion no cambia wg0.conf" cmp -s "$CONF" "$TMP/conf_antes"

# Colision de subredes: una red de Docker en 10.8.0.0/16 debe abortar sin crear nada
RUTAS_ARCHIVO="$TMP/rutas_choque" PATH="$TMP/bin:$PATH" bash "$RAIZ/vps/instalar_wireguard.sh" \
  --dry-run --dir "$TMP/wg_choque" --salida "$TMP/c3.txt" >"$TMP/choque.log" 2>&1
codigo=$?
chequear "choque de subredes: aborta con codigo 1 (codigo $codigo)" test "$codigo" -eq 1
chequear "choque de subredes: lo explica"          grep -q 'choca con la ruta' "$TMP/choque.log"
chequear "choque de subredes: no crea wg0.conf"    test ! -e "$TMP/wg_choque/wg0.conf"

# Lector de puente.env
cat > "$TMP/puente.env" <<'EOF'
# comentario
CAMARA_USUARIO=usuario1
CAMARA_CLAVE=p@ss w$(touch /tmp/NO_DEBE_EXISTIR)&;`x`
RTSP_RUTA=stream1
OTRA_COSA=ignorada
EOF
rm -f /tmp/NO_DEBE_EXISTIR
# shellcheck source=../vps/comun.sh
. "$RAIZ/vps/comun.sh"
PUENTE_ENV="$TMP/puente.env" cargar_env
chequear "env: usuario leido"                   test "$CAMARA_USUARIO" = "usuario1"
chequear "env: clave con simbolos intacta"      test "$CAMARA_CLAVE" = 'p@ss w$(touch /tmp/NO_DEBE_EXISTIR)&;`x`'
chequear "env: no ejecuto codigo del archivo"   test ! -e /tmp/NO_DEBE_EXISTIR
chequear "env: valores por defecto"             test "$ONVIF_PUERTO" = "2020"

# URL RTSP y ocultamiento
url="$(url_rtsp)"
case "$url" in
  rtsp://usuario1:p%40ss%20w%24%28touch*@10.8.0.2:554/stream1) pasa "url_rtsp codifica la clave" ;;
  *) falla "url_rtsp inesperada" ;;
esac
salida="$(printf 'error con %s y %s\n' "$CAMARA_CLAVE" "$(url_codificar "$CAMARA_CLAVE")" | ocultar_clave)"
case "$salida" in
  *"touch"*|*"p@ss"*|*"p%40ss"*) falla "ocultar_clave dejo la clave a la vista" ;;
  *) pasa "ocultar_clave tapa la clave (cruda y codificada)" ;;
esac

# verificar_puente.sh sin tunel: debe fallar ordenadamente y sin filtrar la clave
printf 'CAMARA_IP_TUNEL=127.0.0.1\nCAMARA_USUARIO=u\nCAMARA_CLAVE=SECRETO_UNICO_123\nRTSP_PUERTO=1\nONVIF_PUERTO=2\n' > "$TMP/v.env"
PUENTE_ENV="$TMP/v.env" bash "$RAIZ/vps/verificar_puente.sh" > "$TMP/ver.log" 2>&1
codigo=$?
chequear "verificar_puente.sh sin tunel devuelve 1 (codigo $codigo)" test "$codigo" -eq 1
if grep -q 'SECRETO_UNICO_123' "$TMP/ver.log"; then falla "verificar_puente.sh imprimio la clave"; else pasa "verificar_puente.sh no imprime la clave"; fi
chequear "verificar_puente.sh imprime el resumen"  grep -q '^Resultado:' "$TMP/ver.log"

echo "----"
echo "Resultado: ${OK} pasan, ${MAL} fallan"
[ "$MAL" -eq 0 ]
