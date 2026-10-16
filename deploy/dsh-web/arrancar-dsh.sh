#!/usr/bin/env bash
# ============================================================
#  Jarvis · arranque del DSH web (acceso al agente desde el móvil)
# ------------------------------------------------------------
#  Levanta `dsh web`, lo publica por un proxy (socat) y deja un
#  redirector en el puerto público para que la URL sea SIEMPRE la misma:
#
#      http://<IP>:<público>  →  302  →  http://<IP>:<proxy>/?token=…
#
#  POR QUÉ ESTE FICHERO ESTÁ EN EL REPO
#  Antes vivía suelto en el HOME como `arrancar-dsh.sh` y empezaba con
#  `killall -9 node socat python3`. Como `jarvis.service` corre con el
#  MISMO usuario (`jarvis`) y su proceso es `node`, cada arranque de este
#  servicio mataba a Jarvis (SIGKILL), y systemd lo reiniciaba en bucle.
#  Ahora la limpieza es dirigida —sólo los procesos de ESTE servicio— y el
#  fichero está versionado y probado.
#
#  Uso:
#      arrancar-dsh.sh              arranca (lo normal, desde systemd)
#      arrancar-dsh.sh limpiar      sólo limpia procesos previos y sale
#      arrancar-dsh.sh comprobar    imprime la configuración resuelta y sale
#
#  Configuración por entorno (la unidad la rellena al instalar):
#      JARVIS_DSH_WEB_HOST           IP o nombre del enlace (vacío = autodetectar)
#      JARVIS_DSH_WEB_VERSION        versión FIJADA de @deepseek-ai/dsh
#      JARVIS_DSH_WEB_MAX_OLD_SPACE  tope de heap de V8, en MB
#      JARVIS_DSH_WEB_PORT           puerto interno de `dsh web`   (3080)
#      JARVIS_DSH_WEB_PROXY_PORT     puerto del proxy socat        (3085)
#      JARVIS_DSH_WEB_PUBLIC_PORT    puerto público del redirector (8080)
#      JARVIS_DSH_WEB_LOG            salida de `dsh web`   (/tmp/dsh_output.log)
#      JARVIS_DSH_WEB_WAIT           segundos máximos esperando el token (1200)
# ============================================================
set -euo pipefail

HOST="${JARVIS_DSH_WEB_HOST:-}"
if [ -z "$HOST" ]; then
  HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
HOST="${HOST:-127.0.0.1}"

VERSION="${JARVIS_DSH_WEB_VERSION:-0.2.0-rc.2}"
MAX_OLD_SPACE="${JARVIS_DSH_WEB_MAX_OLD_SPACE:-384}"
PUERTO="${JARVIS_DSH_WEB_PORT:-3080}"
PUERTO_PROXY="${JARVIS_DSH_WEB_PROXY_PORT:-3085}"
PUERTO_PUBLICO="${JARVIS_DSH_WEB_PUBLIC_PORT:-8080}"
FICHERO_LOG="${JARVIS_DSH_WEB_LOG:-/tmp/dsh_output.log}"
ESPERA="${JARVIS_DSH_WEB_WAIT:-1200}"

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Patrones de limpieza: SÓLO lo de este servicio.
#
# NUNCA `killall node`: mataría también a jarvis.service, que corre como el
# mismo usuario. Esa fue exactamente la avería que motivó este fichero.
PATRONES_LIMPIEZA=(
  "@deepseek-ai/dsh"
  "dsh web --no-open"
  "redireccionar.py"
  "socat TCP-LISTEN:${PUERTO_PROXY}"
)

limpiar_anteriores() {
  for patron in "${PATRONES_LIMPIEZA[@]}"; do
    pkill -9 -f "$patron" 2>/dev/null || true
  done
}

comprobar() {
  echo "host          : $HOST"
  echo "version       : $VERSION"
  echo "max_old_space : $MAX_OLD_SPACE"
  echo "puerto        : $PUERTO"
  echo "puerto_proxy  : $PUERTO_PROXY"
  echo "puerto_publico: $PUERTO_PUBLICO"
  echo "log           : $FICHERO_LOG"
  echo "espera        : $ESPERA"
  echo "limpieza      : ${PATRONES_LIMPIEZA[*]}"
}

case "${1:-}" in
  limpiar)
    limpiar_anteriores
    echo "limpieza hecha (patrones: ${PATRONES_LIMPIEZA[*]})"
    exit 0
    ;;
  comprobar)
    comprobar
    exit 0
    ;;
  ''|arrancar) ;;
  *)
    echo "Opción desconocida: $1" >&2
    exit 2
    ;;
esac

# 0) Limpieza dirigida de un arranque anterior (por si se lanzó a mano).
limpiar_anteriores

# 1) El registro contiene el token de acceso: se crea PRIVADO (0600).
umask 077
: > "$FICHERO_LOG"

# 2) `dsh web` en segundo plano, con la versión FIJADA (nada de @latest, que
#    re-resuelve y descarga en cada arranque).
NODE_OPTIONS="--max-old-space-size=$MAX_OLD_SPACE" \
  npx "@deepseek-ai/dsh@$VERSION" web --no-open --trusted-host "$HOST" \
  > "$FICHERO_LOG" 2>&1 &
PID_DSH=$!

echo "--------------------------------------------------------"
echo " IP local : $HOST · dsh $VERSION · heap máximo ${MAX_OLD_SPACE} MB"
echo " Mostrando consola de DeepSeek (esperando token...):"
echo "--------------------------------------------------------"

# 3) Visor en vivo mientras se busca el token.
tail -f "$FICHERO_LOG" &
PID_TAIL=$!
trap 'kill "$PID_TAIL" 2>/dev/null || true' INT TERM

# 4) Esperar el token, con tope de tiempo.
TOKEN=""
for _ in $(seq 1 "$ESPERA"); do
  sleep 1
  if grep -q "token=" "$FICHERO_LOG" 2>/dev/null; then
    TOKEN="$(grep -o 'token=[^ ]*' "$FICHERO_LOG" | head -n 1)"
    break
  fi
  if ! kill -0 "$PID_DSH" 2>/dev/null; then
    break   # dsh web murió: no tiene sentido seguir esperando
  fi
done

kill "$PID_TAIL" 2>/dev/null || true
echo "--------------------------------------------------------"

if [ -z "$TOKEN" ]; then
  echo "ERROR: se agotó la espera ($ESPERA s) sin capturar el token." >&2
  exit 1
fi
echo "¡Token capturado con éxito!"

# 5) Proxy y redirector.
socat "TCP-LISTEN:${PUERTO_PROXY},fork,reuseaddr" "TCP:127.0.0.1:${PUERTO}" &
python3 "$AQUI/redireccionar.py" "$HOST" "$TOKEN" "$PUERTO_PUBLICO" &

echo "--------------------------------------------------------"
echo "¡Sistema completado y actualizado!"
echo "Entra desde el móvil en:  http://$HOST:$PUERTO_PUBLICO"
echo "--------------------------------------------------------"

# 6) El servicio vive mientras viva `dsh web`. Si muere, el script termina y
#    systemd lo reinicia (Restart=on-failure).
wait "$PID_DSH"
