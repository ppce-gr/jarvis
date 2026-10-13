#!/usr/bin/env bash
# ============================================================
#  Jarvis · Ramas de tarea
# ------------------------------------------------------------
#  Cada tarea que modifica Jarvis se hace en una rama `tarea/<slug>`.
#  Antes de abrirla se guarda un *snapshot* del estado: el commit base de
#  `main` y una copia de los ficheros no seguidos/ignorados (configuraciones,
#  claves locales, etc.). El snapshot vive dentro de `.git/jarvis-ramas/`, que
#  nunca se versiona ni se sube: puede contener secretos sin peligro.
#
#  Se puede lanzar desde la terminal (el usuario, si hay que recuperar a mano)
#  y también el agente, que trabaja dentro del mismo repositorio.
#
#  Uso:
#     bash scripts/ramas.sh abrir <slug>   # snapshot + crea tarea/<slug>
#     bash scripts/ramas.sh cerrar         # pruebas + fusiona en main + borra
#     bash scripts/ramas.sh restaurar      # vuelve a main, borra rama y restaura
#     bash scripts/ramas.sh volver <ref>   # rollback de main a un snapshot (tras cerrar)
#     bash scripts/ramas.sh estado         # tarea abierta y rama actual
#     bash scripts/ramas.sh lista          # snapshots guardados
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

GIT_DIR="$(git rev-parse --absolute-git-dir)"
SNAP_ROOT="$GIT_DIR/jarvis-ramas"
ACTUAL="$SNAP_ROOT/actual.json"
BASE_BRANCH="${JARVIS_BRANCH:-main}"

log() { echo "[ramas] $*"; }
die() { echo "[ramas] ERROR: $*" >&2; exit 1; }

require_git() { git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "no es un repositorio git"; }

slug_seguro() {
  local s="$1"
  [[ "$s" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "slug inválido: '$s' (minúsculas, números, . _ -)"
}

manifest_get() {
  node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m[process.argv[2]]??""))' "$1" "$2"
}

# Ficheros no seguidos (incluye los ignorados por .gitignore), salvo ruido.
snapshot_files() {
  { git ls-files --others --exclude-standard
    git ls-files --others --ignored --exclude-standard; } \
    | grep -vE '^(node_modules/|\.git/|\.update-state/)' \
    | sort -u
}

cmd_abrir() {
  local slug="${1:-}"
  [ -n "$slug" ] || die "falta el slug: ramas.sh abrir <slug>"
  slug_seguro "$slug"
  [ -f "$ACTUAL" ] && die "ya hay una tarea abierta (haz 'cerrar' o 'restaurar' antes)"
  local rama_actual; rama_actual="$(git rev-parse --abbrev-ref HEAD)"
  [ "$rama_actual" = "$BASE_BRANCH" ] || die "debes estar en '$BASE_BRANCH' (estás en '$rama_actual')"
  [ -z "$(git status --porcelain)" ] || die "hay cambios sin commitear; deja el árbol limpio antes de abrir la rama"

  local marca base dir n=0
  marca="$(date '+%Y%m%d-%H%M%S')"
  base="$(git rev-parse HEAD)"
  dir="$SNAP_ROOT/${marca}-${slug}"
  mkdir -p "$dir/files"

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    mkdir -p "$dir/files/$(dirname "$f")"
    cp -p "$f" "$dir/files/$f"
    n=$((n + 1))
  done < <(snapshot_files)

  printf '{\n  "slug": "%s",\n  "rama": "tarea/%s",\n  "baseBranch": "%s",\n  "baseCommit": "%s",\n  "at": "%s",\n  "dir": "%s",\n  "ficheros": %s\n}\n' \
    "$slug" "$slug" "$BASE_BRANCH" "$base" "$(date -Is)" "$dir" "$n" > "$dir/manifest.json"
  cp "$dir/manifest.json" "$ACTUAL"

  git switch -c "tarea/$slug"
  log "rama 'tarea/$slug' abierta sobre $BASE_BRANCH ($(git rev-parse --short "$base"))"
  log "snapshot de $n fichero(s) no seguidos en $dir"
}

cmd_restaurar() {
  [ -f "$ACTUAL" ] || die "no hay tarea abierta que restaurar (usa 'lista' y 'volver' si ya cerraste)"
  local dir rama
  dir="$(manifest_get "$ACTUAL" dir)"
  rama="$(manifest_get "$ACTUAL" rama)"
  [ -n "$rama" ] && [ -n "$dir" ] || die "snapshot ilegible: $ACTUAL"

  git switch -f "$BASE_BRANCH"
  if git show-ref --verify --quiet "refs/heads/$rama"; then git branch -D "$rama"; fi

  if [ -d "$dir/files" ]; then
    while IFS= read -r -d '' f; do
      rel="${f#"$dir/files/"}"
      mkdir -p "$REPO_DIR/$(dirname "$rel")"
      cp -p "$f" "$REPO_DIR/$rel"
    done < <(find "$dir/files" -type f -print0)
  fi
  rm -f "$ACTUAL"
  log "vuelto a '$BASE_BRANCH'; rama '$rama' borrada y configuración restaurada desde $dir"
  log "el snapshot queda guardado: 'ramas.sh lista' lo enseña"
}

cmd_cerrar() {
  [ -f "$ACTUAL" ] || die "no hay tarea abierta que cerrar"
  local dir rama slug
  dir="$(manifest_get "$ACTUAL" dir)"
  rama="$(manifest_get "$ACTUAL" rama)"
  slug="$(manifest_get "$ACTUAL" slug)"
  [ -n "$rama" ] || die "snapshot ilegible: $ACTUAL"

  local rama_actual; rama_actual="$(git rev-parse --abbrev-ref HEAD)"
  [ "$rama_actual" = "$rama" ] || die "estás en '$rama_actual' y la tarea abierta es '$rama'"
  [ -z "$(git status --porcelain)" ] || die "hay cambios sin commitear; commitea antes de cerrar"

  if [ -f package.json ]; then
    log "ejecutando pruebas antes de fusionar…"
    npm test
  else
    log "sin package.json: me salto las pruebas"
  fi

  git switch "$BASE_BRANCH"
  git merge --no-ff "$rama" -m "merge: tarea/$slug"
  git branch -d "$rama"
  rm -f "$ACTUAL"
  log "tarea '$slug' fusionada en '$BASE_BRANCH' y rama borrada"
  log "el snapshot queda en $dir: si hay que volver, 'ramas.sh volver $dir'"
}

cmd_volver() {
  local ref="${1:-}"
  [ -n "$ref" ] || die "falta el snapshot: ramas.sh volver <dir|últimos>"
  local dir="$ref"
  if [ "$ref" = "ultimos" ]; then
    dir="$(ls -1d "$SNAP_ROOT"/*/ 2>/dev/null | grep -v 'files/$' | sort | tail -1)"
    dir="${dir%/}"
  fi
  [ -d "$dir" ] || die "no existe el snapshot: $ref"
  local base; base="$(manifest_get "$dir/manifest.json" baseCommit)"
  [ -n "$base" ] || die "snapshot sin baseCommit: $dir"

  git switch -f "$BASE_BRANCH"
  git reset --hard "$base"
  if [ -d "$dir/files" ]; then
    while IFS= read -r -d '' f; do
      rel="${f#"$dir/files/"}"
      mkdir -p "$REPO_DIR/$(dirname "$rel")"
      cp -p "$f" "$REPO_DIR/$rel"
    done < <(find "$dir/files" -type f -print0)
  fi
  log "main devuelta al commit $base y configuración restaurada desde $dir"
  log "AVISO: 'git reset --hard' reescribe la local; si main ya se subió, resuélvelo a mano."
}

cmd_estado() {
  echo "rama actual : $(git rev-parse --abbrev-ref HEAD)"
  if [ -f "$ACTUAL" ]; then
    echo "tarea abierta:"; cat "$ACTUAL"
  else
    echo "sin tarea abierta"
  fi
}

cmd_lista() {
  [ -d "$SNAP_ROOT" ] || { echo "sin snapshots"; return; }
  ls -1 "$SNAP_ROOT" 2>/dev/null | grep -v '^actual\.json$' || echo "sin snapshots"
}

require_git
case "${1:-}" in
  abrir) shift; cmd_abrir "$@" ;;
  cerrar) cmd_cerrar ;;
  restaurar) cmd_restaurar ;;
  volver) shift; cmd_volver "$@" ;;
  estado) cmd_estado ;;
  lista) cmd_lista ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
