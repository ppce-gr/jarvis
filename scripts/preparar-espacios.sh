#!/usr/bin/env bash
# ============================================================
#  Jarvis · Prepara los espacios de trabajo de las ideas
# ------------------------------------------------------------
#  Crea, para cada idea:
#    · <idea>/code/output/  con un .gitignore que ignora su contenido
#      (los ZIP que el usuario descarga, sin ensuciar el repo)
#    · <tmp>/<idea>/        para ficheros intermedios fuera de Git
#
#  Uso:
#    bash scripts/preparar-espacios.sh [idea]
# ============================================================
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAIN_DIR="${JARVIS_BRAIN_DIR:-$(cd "$CODE_DIR/.." && pwd)/jarvis-vault}"
TMP_DIR="${JARVIS_TMP_DIR:-$(cd "$CODE_DIR/.." && pwd)/tmp}"

crear() {
  local idea="$1"
  local out="$BRAIN_DIR/$idea/code/output"
  local tmp="$TMP_DIR/$idea"
  mkdir -p "$out" "$tmp"
  if [ ! -f "$out/.gitignore" ]; then
    printf '# Todo lo que se descarga desde la vista de código.\n*\n!.gitignore\n' > "$out/.gitignore"
  fi
}

mkdir -p "$TMP_DIR"

if [ $# -gt 0 ]; then
  crear "$1"
  echo "[espacios] preparada la idea '$1'"
  exit 0
fi

for dir in "$BRAIN_DIR"/*/; do
  [ -d "$dir" ] || continue
  crear "$(basename "$dir")"
done
echo "[espacios] preparadas todas las ideas en $BRAIN_DIR"
echo "[espacios] temporales en $TMP_DIR"
