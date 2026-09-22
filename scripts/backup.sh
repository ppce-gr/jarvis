#!/usr/bin/env bash
# ============================================================
#  Jarvis · Respaldo en Git de los DOS repositorios
# ------------------------------------------------------------
#  El proyecto vive en dos repositorios separados:
#
#    · código  → este repositorio (público)
#    · memoria → $JARVIS_BRAIN_DIR (privado)
#
#  Este script respalda AMBOS. Un respaldo que sólo cubriera el
#  código dejaría fuera precisamente lo irremplazable: las notas.
#
#  Uso:
#     bash scripts/backup.sh ["mensaje opcional"]
#
#  Importante: un commit local NO es un respaldo, vive en la misma
#  tarjeta que queremos proteger. Por eso el script falla con código
#  1 si no consigue empujar, para que el fallo se note.
# ============================================================
set -uo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAIN_DIR="${JARVIS_BRAIN_DIR:-$(cd "$CODE_DIR/.." && pwd)/jarvis-vault}"
MESSAGE="${1:-chore(jarvis): autosave $(date '+%Y-%m-%d %H:%M:%S')}"

FALLOS=0

# Respalda un repositorio: commit de lo que haya y push de lo pendiente.
respaldar_repo() {
  local dir="$1" etiqueta="$2"
  echo "[backup] ── ${etiqueta}: ${dir}"

  if [ ! -d "$dir/.git" ]; then
    echo "[backup]    no es un repositorio Git; se omite." >&2
    FALLOS=$((FALLOS + 1))
    return
  fi

  local rama
  rama="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)" || {
    echo "[backup]    repositorio inválido; se omite." >&2
    FALLOS=$((FALLOS + 1))
    return
  }

  # --- Commit de los cambios pendientes ---
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    git -C "$dir" add -A

    # Guarda: si se cuela algo sensible, se aborta SIN commitear.
    local sensible
    sensible="$(git -C "$dir" diff --cached --name-only \
      | grep -iE '(^|/)(\.dsh-home|\.git-credentials|\.env|.*\.key|.*\.pem|id_ed25519|id_rsa)' || true)"
    if [ -n "$sensible" ]; then
      echo "[backup]    ABORTADO: ficheros sensibles en el staging:" >&2
      echo "$sensible" | sed 's/^/               /' >&2
      git -C "$dir" reset >/dev/null
      FALLOS=$((FALLOS + 1))
      return
    fi

    # Sin esta comprobación, un commit fallido (por ejemplo, sin identidad de
    # Git configurada) se reportaba como éxito y el respaldo mentía.
    if ! git -C "$dir" commit -m "$MESSAGE" >/dev/null 2>&1; then
      echo "[backup]    ERROR: no se pudo crear el commit." >&2
      echo "[backup]    Comprueba 'git -C $dir config user.name/user.email'." >&2
      FALLOS=$((FALLOS + 1))
      return
    fi
    echo "[backup]    commit $(git -C "$dir" rev-parse --short HEAD)"
  else
    echo "[backup]    sin cambios en el árbol de trabajo"
  fi

  # --- Push de lo pendiente (aunque no haya cambios nuevos) ---
  if ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    echo "[backup]    sin remoto 'origin': sólo respaldo local." >&2
    FALLOS=$((FALLOS + 1))
    return
  fi

  if ! git -C "$dir" fetch origin "$rama" >/dev/null 2>&1; then
    echo "[backup]    AVISO: no se pudo contactar con el remoto (¿sin red?)." >&2
    FALLOS=$((FALLOS + 1))
    return
  fi

  local pendientes
  pendientes="$(git -C "$dir" rev-list --count "origin/${rama}..HEAD" 2>/dev/null || echo 0)"
  if [ "$pendientes" -eq 0 ]; then
    echo "[backup]    sincronizado con origin/${rama}"
    return
  fi

  echo "[backup]    ${pendientes} commit(s) pendientes de subir..."
  if git -C "$dir" push origin "$rama" >/dev/null 2>&1; then
    echo "[backup]    subido a origin/${rama}"
  else
    echo "[backup]    ERROR: no se pudo subir; sigue sólo en la SD." >&2
    FALLOS=$((FALLOS + 1))
  fi
}

respaldar_repo "$CODE_DIR"  "código (público)"
respaldar_repo "$BRAIN_DIR" "memoria (privada)"

echo
if [ "$FALLOS" -gt 0 ]; then
  echo "[backup] TERMINADO CON ${FALLOS} PROBLEMA(S). Revisa los avisos de arriba." >&2
  exit 1
fi
echo "[backup] Los dos repositorios están respaldados y sincronizados."
