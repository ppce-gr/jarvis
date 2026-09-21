#!/usr/bin/env bash
# ============================================================
#  arrancar-dsh.sh  ·  VERSIÓN CORREGIDA
#  Destino sugerido: /home/jarvis/arrancar-dsh.sh
# ------------------------------------------------------------
#  Este script es TEMPORAL: sólo sirve mientras la conversación
#  siga viviendo en `dsh web`. Cuando el chat esté dentro de
#  Jarvis, este servicio y sus dos compañeros se apagan.
#
#  QUÉ SE HA ARREGLADO RESPECTO AL ORIGINAL
#
#  1. YA NO HACE `killall -9 node socat python3`.
#     Eso mataba TODOS los procesos node del sistema, incluido
#     Jarvis, y cualquier otra cosa. Ahora el script sólo
#     gestiona sus propios hijos (trap + PIDs concretos).
#
#  2. YA NO USA `npx @deepseek-ai/dsh@latest`.
#     `@latest` consulta el registro en cada arranque (falla sin
#     red), puede actualizarse solo, y el hash de su caché cambia
#     entre versiones rompiendo rutas absolutas. Ahora usa un
#     binario global con versión fijada.
#
#  3. ESPERA ACTIVA CON LÍMITE CLARO Y MENSAJE ÚTIL si no hay
#     token, en lugar de 20 minutos en silencio.
#
#  4. CIERRE ORDENADO de socat y python al recibir TERM.
# ============================================================
set -euo pipefail

# --- Configuración -------------------------------------------------
# Instala antes:  npm install -g @deepseek-ai/dsh@0.1.5-rc.2
DSH_BIN="${DSH_BIN:-/usr/local/bin/dsh}"
DSH_LOG="${DSH_LOG:-/tmp/dsh_output.log}"
PUERTO_WEB=3080
PUERTO_PROXY=3085
PUERTO_REDIRECT=8080
TIMEOUT_TOKEN=180          # segundos de espera máxima del token

IP_LOCAL="$(hostname -I | awk '{print $1}')"
[ -n "$IP_LOCAL" ] || IP_LOCAL="127.0.0.1"

PIDS=()

limpiar() {
  echo "[arrancar-dsh] Cerrando procesos gestionados por este script..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap limpiar INT TERM EXIT

# --- Comprobaciones previas ---------------------------------------
if [ ! -x "$DSH_BIN" ]; then
  echo "ERROR: no encuentro el binario de DSH en '$DSH_BIN'." >&2
  echo "       Instálalo con:  npm install -g @deepseek-ai/dsh@0.1.5-rc.2" >&2
  exit 1
fi

echo "[arrancar-dsh] IP local detectada: $IP_LOCAL"
echo "[arrancar-dsh] Binario DSH: $DSH_BIN"

# --- 1. DSH web (escucha en loopback por diseño) -------------------
: > "$DSH_LOG"
"$DSH_BIN" web --no-open --trusted-host "$IP_LOCAL" > "$DSH_LOG" 2>&1 &
PIDS+=($!)

echo "[arrancar-dsh] Esperando el token de DSH (máx. ${TIMEOUT_TOKEN}s)..."
TOKEN=""
for ((i = 1; i <= TIMEOUT_TOKEN; i++)); do
  sleep 1
  if grep -q "token=" "$DSH_LOG" 2>/dev/null; then
    TOKEN="$(grep -o 'token=[^ ]*' "$DSH_LOG" | head -n 1)"
    break
  fi
  # Si DSH murió, no tiene sentido seguir esperando.
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then
    echo "ERROR: DSH terminó inesperadamente. Últimas líneas:" >&2
    tail -n 20 "$DSH_LOG" >&2
    exit 1
  fi
done

if [ -z "$TOKEN" ]; then
  echo "ERROR: no se capturó el token en ${TIMEOUT_TOKEN}s. Últimas líneas:" >&2
  tail -n 20 "$DSH_LOG" >&2
  exit 1
fi
echo "[arrancar-dsh] Token capturado."

# --- 2. Puente loopback -> LAN -------------------------------------
socat "TCP-LISTEN:${PUERTO_PROXY},fork,reuseaddr" "TCP:127.0.0.1:${PUERTO_WEB}" &
PIDS+=($!)

# --- 3. Redirección con token para tener un enlace fijo ------------
python3 /home/jarvis/redireccionar.py "$IP_LOCAL" "$TOKEN" &
PIDS+=($!)

echo "--------------------------------------------------------"
echo " Listo. Enlace fijo desde el móvil:"
echo "   http://$IP_LOCAL:$PUERTO_REDIRECT"
echo " (destino real: :$PUERTO_PROXY -> :$PUERTO_WEB)"
echo "--------------------------------------------------------"

# Mantener vivo el servicio: systemd vigila este proceso.
wait -n
