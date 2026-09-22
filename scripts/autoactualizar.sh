#!/usr/bin/env bash
# ============================================================
#  Jarvis · Autoactualización con reversión
# ------------------------------------------------------------
#  ESTE ES EL FICHERO MÁS DELICADO DEL PROYECTO. Un fallo aquí
#  deja la Raspberry sin arrancar y sin acceso por red.
#
#  POR QUÉ NO LO EJECUTA JARVIS
#  Si Jarvis se reiniciara a sí mismo y el código nuevo no
#  arranca, se quedaría sin la herramienta que haría la
#  recuperación. Por eso lo lanza systemd desde FUERA del árbol
#  de procesos de Jarvis (jarvis-autoupdate.path → .service):
#  así el actualizador sobrevive al reinicio y puede comprobar si
#  el arranque funcionó.
#
#  POR QUÉ ESTE FICHERO NO SE ACTUALIZA SOLO
#  `instalar.sh` copia este script a /usr/local/sbin/jarvis-actualizar
#  y systemd ejecuta ESA copia, no la del repositorio. Así una
#  actualización nunca modifica el script que la está ejecutando
#  (bash lee el fichero mientras lo interpreta: automodificarse es
#  una bomba). Si cambias este script, hay que reinstalarlo.
#
#  LAS CINCO BARRERAS, EN ORDEN DE COSTE
#    1. Árbol limpio       — si hay cambios sin commitear, ABORTA.
#                            Por construcción no se pierde trabajo.
#    2. Respaldo previo    — los dos repos, commit + push. Sin
#                            respaldo NO se actualiza.
#    3. Fast-forward only  — o avanza, o se niega. Nunca fusiona,
#                            nunca sobrescribe commits locales.
#    4. Pruebas + arranque — se verifica que el código nuevo pasa
#       en puerto aparte     los tests Y que el servidor arranca de
#                            verdad, ANTES de tocar el servicio.
#    5. Reversión          — si tras reiniciar no responde, vuelve
#                            sola al último commit PROBADO.
#
#  Uso:
#     jarvis-actualizar              actualiza
#     jarvis-actualizar --check      sólo mira si hay novedades
#     jarvis-actualizar --rollback   vuelve al último commit bueno
#     jarvis-actualizar --dry-run    simula, no toca nada
# ============================================================
set -uo pipefail

# --- Configuración -------------------------------------------------
CODE_DIR="${JARVIS_CODE_DIR:-/home/jarvis/jarvis/jarvis}"
BRAIN_DIR="${JARVIS_BRAIN_DIR:-/home/jarvis/jarvis/jarvis-vault}"
STATE_DIR="${JARVIS_UPDATE_STATE:-/home/jarvis/jarvis/.update-state}"
SERVICE="${JARVIS_SERVICE:-jarvis.service}"
HEALTH_URL="${JARVIS_HEALTH_URL:-http://127.0.0.1:3081/api/health}"
PROJECTS_URL="${JARVIS_PROJECTS_URL:-http://127.0.0.1:3081/api/projects}"
SMOKE_PORT="${JARVIS_SMOKE_PORT:-3099}"
HEALTH_TRIES="${JARVIS_HEALTH_TRIES:-30}"
HEALTH_WAIT="${JARVIS_HEALTH_WAIT:-2}"
BRANCH="${JARVIS_BRANCH:-main}"
BITACORA="$BRAIN_DIR/sistema-jarvis/logs/orchestrator.log"

MODO="actualizar"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --check)    MODO="check" ;;
    --rollback) MODO="rollback" ;;
    --dry-run)  DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
LOG_FICHERO="$STATE_DIR/autoactualizacion.log"

log() {
  local linea="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$linea" | tee -a "$LOG_FICHERO"
}

bitacora() {
  [ -f "$BITACORA" ] || return 0
  echo "" >> "$BITACORA"
  echo "[$(date '+%Y-%m-%d %H:%M')] AUTOACTUALIZACIÓN · $*" >> "$BITACORA"
}

morir() { log "ERROR: $*"; bitacora "FALLÓ: $*"; exit 1; }

# Reinicia el servicio y espera a que responda de verdad: no basta con que el
# proceso exista, tiene que servir /api/health Y poder leer la memoria.
# Se define aquí arriba porque el modo --rollback también la usa.
reiniciar_y_verificar() {
  log "Reiniciando $SERVICE..."
  sudo -n systemctl restart "$SERVICE" 2>>"$LOG_FICHERO" || {
    log "AVISO: 'sudo systemctl restart' falló (¿falta la regla de sudoers?)"
    return 1
  }
  for i in $(seq 1 "$HEALTH_TRIES"); do
    sleep "$HEALTH_WAIT"
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      # No basta con /api/health: hay que comprobar que LEE la memoria.
      if curl -fsS --max-time 5 "$PROJECTS_URL" >/dev/null 2>&1; then
        log "El servicio responde y lee la memoria (intento $i)."
        return 0
      fi
    fi
    log "  esperando al servicio... ($i/$HEALTH_TRIES)"
  done
  return 1
}


# ---------------------------------------------------------------
# 0. Cerrojo: dos actualizaciones a la vez se pisarían
# ---------------------------------------------------------------
exec 9>"$STATE_DIR/lock"
if ! flock -n 9; then
  log "Ya hay una actualización en curso. Se sale sin hacer nada."
  exit 0
fi

log "════ Inicio ($MODO) ════"

# ---------------------------------------------------------------
# Comprobaciones previas
# ---------------------------------------------------------------
[ -d "$CODE_DIR/.git" ] || morir "no encuentro el repositorio de código en $CODE_DIR"
cd "$CODE_DIR" || morir "no puedo entrar en $CODE_DIR"

if [ "$MODO" = "actualizar" ]; then
  if ! systemctl list-unit-files "$SERVICE" >/dev/null 2>&1 \
     || [ -z "$(systemctl list-unit-files "$SERVICE" 2>/dev/null | grep -c "$SERVICE")" ]; then
    morir "el servicio $SERVICE no está instalado. La actualización necesita poder reiniciarlo. Ejecuta: sudo bash deploy/instalar.sh --jarvis"
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  log "AVISO: se está ejecutando como root. Lo normal es hacerlo como el usuario dueño del repositorio."
fi

# ---------------------------------------------------------------
# Anclas: de dónde venimos y cuál fue el último commit PROBADO
# ---------------------------------------------------------------
PREV="$(git rev-parse HEAD)" || morir "no puedo leer HEAD"
LAST_GOOD_FILE="$STATE_DIR/last-good"
if [ -f "$LAST_GOOD_FILE" ] && git cat-file -e "$(cat "$LAST_GOOD_FILE")^{commit}" 2>/dev/null; then
  LAST_GOOD="$(cat "$LAST_GOOD_FILE")"
else
  LAST_GOOD="$PREV"
  log "Sin ancla previa; se toma el commit actual como último bueno."
fi
log "Actual: $(git rev-parse --short "$PREV") · último bueno: $(git rev-parse --short "$LAST_GOOD")"

# ---------------------------------------------------------------
# Modo rollback manual
# ---------------------------------------------------------------
if [ "$MODO" = "rollback" ]; then
  log "Reversión manual a $(git rev-parse --short "$LAST_GOOD")"
  [ "$DRY_RUN" -eq 1 ] && { log "(simulación) no se toca nada"; exit 0; }
  git reset --hard "$LAST_GOOD" || morir "no pude revertir"
  reiniciar_y_verificar || morir "revertido, pero el servicio no responde"
  bitacora "Reversión manual al commit $(git rev-parse --short "$LAST_GOOD")"
  exit 0
fi

# ---------------------------------------------------------------
# BARRERA 1 · Árbol limpio
# ---------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  morir "hay cambios sin commitear en el código. Commitea o descarta antes de actualizar (no se toca nada)."
fi
log "Barrera 1 OK: árbol de trabajo limpio."

# ---------------------------------------------------------------
# Consultar novedades
# ---------------------------------------------------------------
log "Consultando origin/$BRANCH..."
if ! git fetch origin "$BRANCH" >/dev/null 2>&1; then
  morir "no pude contactar con el remoto (¿sin red?)"
fi
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$REMOTE" = "$PREV" ]; then
  log "Ya está al día ($(git rev-parse --short "$PREV"))."
  [ "$MODO" = "check" ] && exit 0
  exit 0
fi

if ! git merge-base --is-ancestor "$PREV" "$REMOTE"; then
  morir "las ramas han divergido: hay commits locales que no están en origin/$BRANCH. No se toca nada para no perderlos."
fi
log "Hay novedades: $(git rev-parse --short "$PREV") → $(git rev-parse --short "$REMOTE")"
[ "$MODO" = "check" ] && { log "(--check: no se aplica nada)"; exit 0; }

if [ "$DRY_RUN" -eq 1 ]; then
  log "(simulación) se aplicaría el fast-forward y se verificaría el arranque. No se toca nada."
  exit 0
fi

# ---------------------------------------------------------------
# BARRERA 2 · Respaldo previo de los dos repositorios
# ---------------------------------------------------------------
log "Barrera 2: respaldo previo..."
if ! JARVIS_BRAIN_DIR="$BRAIN_DIR" bash "$CODE_DIR/scripts/backup.sh" \
       "chore: respaldo antes de actualizar" >>"$LOG_FICHERO" 2>&1; then
  morir "el respaldo previo falló. Sin respaldo no se actualiza."
fi
log "Barrera 2 OK: los dos repositorios respaldados."

# ---------------------------------------------------------------
# BARRERA 3 · Aplicar con fast-forward únicamente
# ---------------------------------------------------------------
log "Barrera 3: aplicando (sólo fast-forward)..."
if ! git merge --ff-only "origin/$BRANCH" >>"$LOG_FICHERO" 2>&1; then
  git reset --hard "$PREV" >/dev/null 2>&1
  morir "el fast-forward falló. Se ha vuelto a $PREV y no se ha tocado el servicio."
fi
log "Barrera 3 OK: código en $(git rev-parse --short HEAD)."

# ---------------------------------------------------------------
# BARRERA 4 · Verificar ANTES de tocar el servicio
#   4a. La suite de pruebas
#   4b. Que el servidor arranque de verdad, en un puerto aparte
#       y con una carpeta de memoria temporal (no se tocan las
#       notas reales).
# ---------------------------------------------------------------
revertir_codigo() {
  log "Revirtiendo el código a $(git rev-parse --short "$1")..."
  git reset --hard "$1" >/dev/null 2>&1 || log "AVISO: la reversión del código falló"
}

log "Barrera 4a: ejecutando la suite de pruebas..."
if ! timeout 300 npm test >>"$LOG_FICHERO" 2>&1; then
  revertir_codigo "$PREV"
  morir "las pruebas fallan con el código nuevo. Se ha vuelto a $(git rev-parse --short "$PREV") y Jarvis NO se ha reiniciado."
fi
log "Barrera 4a OK: pruebas en verde."

log "Barrera 4b: comprobando que el servidor arranca de verdad..."
BRAIN_TEMPORAL="$(mktemp -d)"
JARVIS_PORT="$SMOKE_PORT" JARVIS_BRAIN_DIR="$BRAIN_TEMPORAL" \
  node src/index.js >>"$LOG_FICHERO" 2>&1 &
SMOKE_PID=$!

arranca=0
for _ in $(seq 1 15); do
  sleep 1
  if curl -fsS --max-time 2 "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1; then
    arranca=1
    break
  fi
  kill -0 "$SMOKE_PID" 2>/dev/null || break
done
kill "$SMOKE_PID" 2>/dev/null
wait "$SMOKE_PID" 2>/dev/null
rm -rf "$BRAIN_TEMPORAL"

if [ "$arranca" -ne 1 ]; then
  revertir_codigo "$PREV"
  morir "el código nuevo NO arranca. Se ha vuelto a $(git rev-parse --short "$PREV") y Jarvis sigue con el código anterior, intacto."
fi
log "Barrera 4b OK: el servidor nuevo arranca y responde."

# ---------------------------------------------------------------
# BARRERA 5 · Reiniciar el servicio y comprobar de verdad
# ---------------------------------------------------------------
if reiniciar_y_verificar; then
  echo "$(git rev-parse HEAD)" > "$LAST_GOOD_FILE"
  log "✅ Actualización completada. Nuevo ancla: $(git rev-parse --short HEAD)"
  bitacora "OK · actualizado de $(git rev-parse --short "$PREV") a $(git rev-parse --short HEAD)"
  exit 0
fi

log "El servicio no responde con el código nuevo. Iniciando REVERSIÓN..."
bitacora "El código nuevo no arrancó; revirtiendo a $(git rev-parse --short "$LAST_GOOD")"
revertir_codigo "$LAST_GOOD"

if reiniciar_y_verificar; then
  log "✅ Revertido a $(git rev-parse --short "$LAST_GOOD") y funcionando."
  bitacora "REVERTIDO a $(git rev-parse --short "$LAST_GOOD") y funcionando"
  exit 1
fi

log "🚨 CRÍTICO: ni con el commit probado arranca el servicio."
log "   Intervención manual necesaria. Estado:"
log "     código en $(git rev-parse --short HEAD)"
log "     último bueno $(git rev-parse --short "$LAST_GOOD")"
log "     log completo en $LOG_FICHERO"
bitacora "CRÍTICO: ni con el commit probado arranca. Hace falta intervención manual."
exit 2
