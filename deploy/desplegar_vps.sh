#!/usr/bin/env bash
# Despliega el sistema de alarma en la VPS y verifica que responda.
# Uso (desde la carpeta deploy):   ./desplegar_vps.sh
set -euo pipefail
cd "$(dirname "$0")"

DOMINIO="${DOMINIO:-sentinelhome.ddns.net}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.proxy.yml)

echo "==> Actualizando el codigo"
git pull --ff-only

echo "==> Verificando que exista la red del proxy"
docker network inspect ochil_edge >/dev/null 2>&1 || {
  echo "No existe la red ochil_edge. Revisa el nombre con docker network ls y ajusta docker-compose.proxy.yml."
  exit 1
}

echo "==> Construyendo y levantando"
"${COMPOSE[@]}" up -d --build

echo "==> Esperando al backend (hasta 40 s)"
for i in $(seq 1 20); do
  if curl -fs "http://localhost:${BACKEND_PORT:-8080}/auth/estado" >/dev/null; then break; fi
  sleep 2
done
echo -n "Local:   "; curl -s "http://localhost:${BACKEND_PORT:-8080}/auth/estado"; echo
echo -n "Publico: "; PUBLICO=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://${DOMINIO}/auth/estado" || true); echo "$PUBLICO"

echo "==> Ultimas lineas del backend"
docker logs --tail 12 alarma_backend
echo
if [ "$PUBLICO" = "200" ]; then
  echo "Conectado a ${DOMINIO}: OK"
else
  echo "Conectado a ${DOMINIO}: FALLA (respuesta ${PUBLICO}). El proxy no ve al backend: revisa docker-compose.proxy.yml y que el dominio apunte a este servidor."
  exit 1
fi
