#!/usr/bin/env bash
# ============================================================
#  Jarvis · Respaldo en Git
# ------------------------------------------------------------
#  Hace commit de todos los cambios del workspace. Pensado para
#  ejecutarse por cron cada 30 minutos: si la SD muere, el trabajo
#  está a salvo en Git.
#
#  Uso:
#     bash scripts/backup.sh ["mensaje opcional"]
# ============================================================
set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE"

MESSAGE="${1:-chore(jarvis): autosave $(date '+%Y-%m-%d %H:%M:%S')}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[backup] No es un repositorio Git. Ejecuta 'git init' primero." >&2
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "[backup] Sin cambios que guardar."
  exit 0
fi

git add -A

# --- Guarda de seguridad ---------------------------------------------
# `git add -A` respeta .gitignore, pero si ese fichero se rompiera subiriamos
# credenciales. Antes de commitear se comprueba que no haya nada sensible en
# el area de staging; si lo hay, se aborta SIN subir nada.
SENSIBLE=$(git diff --cached --name-only | grep -iE '(^|/)(\.dsh-home|\.git-credentials|\.env|.*\.key|.*\.pem|id_ed25519|id_rsa)' || true)
if [ -n "$SENSIBLE" ]; then
  echo "[backup] ABORTADO: se iban a versionar ficheros sensibles:" >&2
  echo "$SENSIBLE" | sed 's/^/           /' >&2
  echo "[backup] Revisa .gitignore. No se ha creado ningun commit." >&2
  git reset >/dev/null
  exit 1
fi
# ---------------------------------------------------------------------

git commit -m "$MESSAGE" >/dev/null
echo "[backup] Commit creado: $(git rev-parse --short HEAD)"

# Si existe un remoto configurado, intenta subir. Si falla (sin red),
# no rompas la ejecución de cron: el commit local ya protege el trabajo.
if git remote get-url origin >/dev/null 2>&1; then
  if git push origin "$(git rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1; then
    echo "[backup] Subido al remoto."
  else
    echo "[backup] Aviso: no se pudo subir al remoto (¿sin conexión?). Commit local conservado."
  fi
fi
