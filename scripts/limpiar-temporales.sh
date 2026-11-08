#!/usr/bin/env bash
# ============================================================
#  Jarvis · Limpia los ficheros temporales de las ideas
# ------------------------------------------------------------
#  Borra SÓLO dentro de la carpeta de temporales. Es seguro: allí no
#  hay nada que pertenezca al proyecto (sólo descargas, renders,
#  pruebas y logs pesados).
#
#  Uso:
#    bash scripts/limpiar-temporales.sh listar
#    bash scripts/limpiar-temporales.sh borrar-idea <idea>
#    bash scripts/limpiar-temporales.sh borrar-todo --si
# ============================================================
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${JARVIS_TMP_DIR:-$(cd "$CODE_DIR/.." && pwd)/tmp}"

die() { echo "[temporales] ERROR: $*" >&2; exit 1; }

# Guardas: nunca borrar la raíz ni una ruta vacía.
[ -n "$TMP_DIR" ] || die "JARVIS_TMP_DIR vacío"
[ "$TMP_DIR" != "/" ] || die "JARVIS_TMP_DIR no puede ser /"

accion="${1:-listar}"
case "$accion" in
  listar)
    [ -d "$TMP_DIR" ] || { echo "[temporales] no existe $TMP_DIR"; exit 0; }
    du -sh "$TMP_DIR"/* 2>/dev/null || true
    ;;
  borrar-idea)
    idea="${2:-}"
    [ -n "$idea" ] || die "falta el id de la idea"
    [[ "$idea" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "id de idea inválido"
    rm -rf -- "$TMP_DIR/$idea"
    mkdir -p "$TMP_DIR/$idea"
    echo "[temporales] borrada la idea '$idea'"
    ;;
  borrar-todo)
    [ "${2:-}" = "--si" ] || die "para borrar todo usa: borrar-todo --si"
    [ -d "$TMP_DIR" ] || exit 0
    find "$TMP_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    echo "[temporales] borrado todo el contenido de $TMP_DIR"
    ;;
  *)
    die "acción desconocida: $accion"
    ;;
esac
