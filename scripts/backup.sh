#!/usr/bin/env bash
# ============================================================
#  Jarvis · Respaldo en Git
# ------------------------------------------------------------
#  Hace commit de los cambios del workspace y SIEMPRE empuja lo que
#  quede pendiente. Pensado para un temporizador cada 30 minutos: si
#  la SD muere, el trabajo está a salvo en el remoto.
#
#  Uso:
#     bash scripts/backup.sh ["mensaje opcional"]
#
#  Importante: el commit local NO es un respaldo. Vive en la misma
#  tarjeta que queremos proteger. Por eso este script falla con
#  código 1 si no consigue empujar, para que el fallo se note en vez
#  de pasar desapercibido durante semanas.
# ============================================================
set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE"

MESSAGE="${1:-chore(jarvis): autosave $(date '+%Y-%m-%d %H:%M:%S')}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[backup] No es un repositorio Git. Ejecuta 'git init' primero." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# ------------------------------------------------------------
# 1. Commitear lo que haya en el árbol de trabajo
# ------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  git add -A

  # --- Guarda de seguridad -------------------------------------------
  # `git add -A` respeta .gitignore, pero si ese fichero se rompiera
  # subiriamos credenciales. Si aparece algo sensible en el staging se
  # aborta SIN crear commit.
  SENSIBLE=$(git diff --cached --name-only | grep -iE '(^|/)(\.dsh-home|\.git-credentials|\.env|.*\.key|.*\.pem|id_ed25519|id_rsa)' || true)
  if [ -n "$SENSIBLE" ]; then
    echo "[backup] ABORTADO: se iban a versionar ficheros sensibles:" >&2
    echo "$SENSIBLE" | sed 's/^/           /' >&2
    echo "[backup] Revisa .gitignore. No se ha creado ningun commit." >&2
    git reset >/dev/null
    exit 1
  fi
  # -------------------------------------------------------------------

  git commit -m "$MESSAGE" >/dev/null
  echo "[backup] Commit creado: $(git rev-parse --short HEAD)"
else
  echo "[backup] Sin cambios en el arbol de trabajo."
fi

# ------------------------------------------------------------
# 2. Empujar SIEMPRE que quede algo pendiente
#
# El bug que esto arregla: antes, si no habia cambios en el arbol de
# trabajo, el script salia sin mirar si habia commits locales sin subir
# (por ejemplo, hechos a mano). El respaldo se quedaba en la SD y nadie
# se enteraba.
# ------------------------------------------------------------
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[backup] Sin remoto 'origin' configurado: solo hay respaldo local."
  exit 0
fi

git fetch origin "$BRANCH" >/dev/null 2>&1 || {
  echo "[backup] AVISO: no se pudo contactar con el remoto (¿sin red?)." >&2
  echo "[backup] Los commits siguen SOLO en la SD. Se reintentara." >&2
  exit 1
}

PENDIENTES=$(git rev-list --count "origin/${BRANCH}..HEAD" 2>/dev/null || echo 0)
if [ "$PENDIENTES" -eq 0 ]; then
  echo "[backup] Todo sincronizado con origin/${BRANCH}."
  exit 0
fi

echo "[backup] ${PENDIENTES} commit(s) pendientes de subir..."

if git push origin "$BRANCH" >/dev/null 2>&1; then
  echo "[backup] Subido al remoto (origin/${BRANCH})."
else
  echo "[backup] ERROR: no se pudo subir. Los commits siguen SOLO en la SD." >&2
  exit 1
fi
