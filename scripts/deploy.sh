#!/usr/bin/env bash
# ============================================================
#  Jarvis · Despliegue en una máquina nueva
# ------------------------------------------------------------
#  Clona (si procede), comprueba requisitos, ejecuta los tests
#  y arranca la interfaz. Objetivo: revivir Jarvis en minutos
#  tras migrar de hardware o perder la SD.
#
#  Uso:
#     bash scripts/deploy.sh              # en el repo ya clonado
#     bash scripts/deploy.sh <url-repo>   # clona y despliega
# ============================================================
set -euo pipefail

REPO_URL="${1:-}"

if [ -n "$REPO_URL" ]; then
  TARGET="${JARVIS_DIR:-$HOME/jarvis}"
  if [ -d "$TARGET/.git" ]; then
    echo "[deploy] El directorio $TARGET ya existe; actualizando..."
    git -C "$TARGET" pull --ff-only
  else
    echo "[deploy] Clonando $REPO_URL en $TARGET..."
    git clone "$REPO_URL" "$TARGET"
  fi
  cd "$TARGET"
else
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
fi

echo "[deploy] Workspace: $(pwd)"

# --- Requisitos ---
if ! command -v node >/dev/null 2>&1; then
  echo "[deploy] ERROR: falta Node.js (se requiere v20+)." >&2
  echo "         Raspberry Pi OS:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[deploy] ERROR: Node.js $(node -v) es demasiado antiguo (se requiere v20+)." >&2
  exit 1
fi
echo "[deploy] Node.js $(node -v) OK"

# --- Dependencias ---
# El proyecto no tiene dependencias de runtime. Si algún día las tuviera,
# este bloque las instalará automáticamente.
if node -e 'const p=require("./package.json"); process.exit(p.dependencies&&Object.keys(p.dependencies).length?0:1)' 2>/dev/null; then
  echo "[deploy] Instalando dependencias..."
  npm install --omit=dev
else
  echo "[deploy] Sin dependencias de runtime (cero npm install)."
fi

# --- Verificación ---
echo "[deploy] Ejecutando pruebas..."
npm test

# --- Arranque ---
PORT="${JARVIS_PORT:-3081}"
echo ""
echo "[deploy] Todo listo. Arrancando Jarvis en el puerto $PORT ..."
echo "[deploy] Abre  http://<ip-de-esta-maquina>:$PORT  desde tu móvil o PC."
echo ""
exec npm start
