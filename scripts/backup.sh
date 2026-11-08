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
#
#  QUIÉN CREA COMMITS
#  La memoria (privada) se autosalva: son notas irremplazables y da
#  igual que la historia tenga ruido.
#  El código (público) NO: sólo se sube lo que ya esté commiteado. Su
#  historia la lee gente, y un "autosave" cada media hora con el
#  trabajo a medias de un agente la ensucia y puede dejar main sin
#  pasar las pruebas. El código se commitea a propósito.
#  Si hay trabajo sin commitear, se avisa para que no se dé por
#  respaldado lo que no lo está. Para forzar el autosalvado también en
#  el código:  JARVIS_BACKUP_COMMIT_CODE=1
# ============================================================
set -uo pipefail
# Nunca esperar a que alguien teclee credenciales: el backup corre solo.
export GIT_TERMINAL_PROMPT=0

# Límites para que un remoto lento no secuestre la Raspberry.
FETCH_TIMEOUT="${JARVIS_BACKUP_FETCH_TIMEOUT:-60}"
PUSH_TIMEOUT="${JARVIS_BACKUP_PUSH_TIMEOUT:-180}"
MAX_GIT_MB="${JARVIS_BACKUP_MAX_GIT_MB:-512}"

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAIN_DIR="${JARVIS_BRAIN_DIR:-$(cd "$CODE_DIR/.." && pwd)/jarvis-vault}"
MESSAGE="${1:-chore(jarvis): autosave $(date '+%Y-%m-%d %H:%M:%S')}"
COMMIT_CODE="$( [ "${JARVIS_BACKUP_COMMIT_CODE:-0}" = "1" ] && echo si || echo no )"

FALLOS=0

# Git sin mantenimiento automático. En la Pi, un `git gc`/repack sobre un
# historial grande puede tenerla media hora ocupada y dejar el chat sin CPU.
# Se pasa por entorno para que también lo respete `timeout`.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=gc.auto
export GIT_CONFIG_VALUE_0=0
export GIT_CONFIG_KEY_1=maintenance.auto
export GIT_CONFIG_VALUE_1=false

# Respalda un repositorio: commit de lo que haya (si se permite) y push de lo pendiente.
respaldar_repo() {
  local dir="$1" etiqueta="$2" commitear="${3:-si}"
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
  # Con el árbol limpio NO se crea ningún commit: nunca ha habido commits
  # vacíos, pero conviene que quede explícito.
  local sucios
  sucios="$(git -C "$dir" status --porcelain | wc -l)"
  if [ "$sucios" -eq 0 ]; then
    echo "[backup]    sin cambios en el árbol de trabajo"
  elif [ "$commitear" != "si" ]; then
    echo "[backup]    ${sucios} fichero(s) sin commitear que NO se respaldan, a propósito:"
    echo "[backup]    el código se commitea a propósito, no por temporizador."
    echo "[backup]    Para autosalvarlo también aquí:  JARVIS_BACKUP_COMMIT_CODE=1"
  else
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
  fi

  # --- Push de lo pendiente (aunque no haya cambios nuevos) ---
  if ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    echo "[backup]    sin remoto 'origin': sólo respaldo local." >&2
    FALLOS=$((FALLOS + 1))
    return
  fi

  # Un historial enorme no se puede subir desde la Pi sin dejarla sin aire.
  # El commit local ya está hecho; se avisa y se evita el push eterno.
  local git_mb
  git_mb="$(du -sm "$dir/.git" 2>/dev/null | awk '{print $1}')"
  git_mb="${git_mb:-0}"
  if [ "$git_mb" -gt "$MAX_GIT_MB" ] && [ "${JARVIS_BACKUP_FORZAR_PUSH:-0}" != "1" ]; then
    echo "[backup]    AVISO: el historial ocupa ${git_mb} MB (límite ${MAX_GIT_MB} MB)." >&2
    echo "[backup]    No se intenta subir para no secuestrar la Pi; el commit local sí queda hecho." >&2
    echo "[backup]    Limpia el historial o usa JARVIS_BACKUP_FORZAR_PUSH=1 para intentarlo igual." >&2
    FALLOS=$((FALLOS + 1))
    return
  fi

  local error_git rc_fetch=0
  error_git="$(timeout "$FETCH_TIMEOUT" git -C "$dir" fetch origin "$rama" 2>&1 >/dev/null)" || rc_fetch=$?
  if [ "$rc_fetch" -ne 0 ]; then
    if [ "$rc_fetch" -eq 124 ]; then
      echo "[backup]    ERROR: el fetch superó ${FETCH_TIMEOUT}s; se aborta." >&2
    else
      echo "[backup]    ERROR: no se pudo contactar con el remoto." >&2
    fi
    echo "$error_git" | head -3 | sed 's/^/               /' >&2
    # El fallo más habitual no es la red, sino la clave de host sin aceptar.
    if echo "$error_git" | grep -q "Host key verification failed"; then
      echo "[backup]    PISTA: falta la clave de host en ~/.ssh/known_hosts." >&2
      echo "[backup]           Arréglalo con:  sudo bash deploy/instalar.sh --backup" >&2
    fi
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
  local push_rc=0 push_out
  push_out="$(timeout "$PUSH_TIMEOUT" git -C "$dir" push origin "$rama" 2>&1)" || push_rc=$?
  if [ "$push_rc" -eq 0 ]; then
    echo "[backup]    subido a origin/${rama}"
  else
    echo "[backup]    ERROR: no se pudo subir; sigue sólo en la SD." >&2
    if [ "$push_rc" -eq 124 ]; then
      echo "[backup]    El push superó ${PUSH_TIMEOUT}s y se abortó para liberar la Pi." >&2
    fi
    echo "$push_out" | tail -5 | sed 's/^/               /' >&2
    FALLOS=$((FALLOS + 1))
  fi
}

respaldar_repo "$CODE_DIR"  "código (público)" "$COMMIT_CODE"
respaldar_repo "$BRAIN_DIR" "memoria (privada)" "si"

echo
if [ "$FALLOS" -gt 0 ]; then
  echo "[backup] TERMINADO CON ${FALLOS} PROBLEMA(S). Revisa los avisos de arriba." >&2
  exit 1
fi
echo "[backup] Los dos repositorios están respaldados y sincronizados."
