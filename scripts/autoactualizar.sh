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
# Se lee la configuración del sistema si existe: es lo que permite ejecutar este
# script a mano desde fuera del repositorio (la copia instalada, por ejemplo) sin
# pasarle las rutas. El fichero usa ${VAR:-valor}, así que lo que ya venga en el
# entorno sigue teniendo la última palabra.
[ -f /etc/jarvis/jarvis.conf ] && . /etc/jarvis/jarvis.conf

# Sin configuración, todo se deduce de dónde esté este script: es scripts/ dentro
# del repositorio de código. Así un clon funciona sin configurar nada.
AQUI_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEDUCIDO="$(cd "$AQUI_SCRIPT/.." && pwd)"
BASE_DEDUCIDA="$(dirname "$REPO_DEDUCIDO")"

CODE_DIR="${JARVIS_CODE_DIR:-$REPO_DEDUCIDO}"
BRAIN_DIR="${JARVIS_BRAIN_DIR:-$BASE_DEDUCIDA/jarvis-vault}"
STATE_DIR="${JARVIS_UPDATE_STATE:-$BASE_DEDUCIDA/.update-state}"
SERVICE="${JARVIS_SERVICE:-jarvis.service}"
PORT="${JARVIS_PORT:-3081}"
HEALTH_URL="${JARVIS_HEALTH_URL:-http://127.0.0.1:$PORT/api/health}"
PROJECTS_URL="${JARVIS_PROJECTS_URL:-http://127.0.0.1:$PORT/api/projects}"
STATUS_URL="${JARVIS_STATUS_URL:-http://127.0.0.1:$PORT/api/system/status}"
SMOKE_PORT="${JARVIS_SMOKE_PORT:-3099}"
HEALTH_TRIES="${JARVIS_HEALTH_TRIES:-30}"
HEALTH_WAIT="${JARVIS_HEALTH_WAIT:-2}"
BRANCH="${JARVIS_BRANCH:-main}"
BITACORA="$BRAIN_DIR/sistema-jarvis/logs/orchestrator.log"
# La bandera que vigila systemd. OJO: hay que BORRARLA al terminar. `PathExists`
# sólo dispara cuando el fichero aparece, así que si se queda ahí la próxima
# petición no haría nada: la actualización funcionaría una sola vez.
BANDERA="${JARVIS_UPDATE_FLAG:-$BASE_DEDUCIDA/.update-request}"
# La COPIA INSTALADA de este mismo script. systemd ejecuta ÉSTA (ver ExecStart
# en deploy/systemd/jarvis-autoupdate.service.in), no la del repositorio.
INSTALADO="${JARVIS_UPDATER_INSTALLED:-${JARVIS_SBIN_DIR:-/usr/local/sbin}/jarvis-actualizar}"

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
# Post-mortem de la última actualización fallida: qué se intentaba, dónde falló y
# a dónde se volvió. Lo lee la interfaz, y lo puede leer Jarvis para arreglarlo.
FALLO_FICHERO="$STATE_DIR/ultimo-fallo.txt"

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

# ---------------------------------------------------------------
# Post-mortem de un fallo.
# ---------------------------------------------------------------
# Deja por escrito QUÉ se intentaba, DÓNDE falló, A DÓNDE se volvió y si el
# servicio quedó vivo. La idea es que no haya que rebuscar en un registro de
# cientos de líneas: se lee de un vistazo, y Jarvis puede leerlo para proponer
# el arreglo. Se borra en cuanto una actualización sale bien.
registrar_fallo() {   # $1 fase · $2 mensaje · $3 revertido(si/no) · $4 servicio_vivo(si/no)
  local fase="$1" mensaje="$2" revertido="$3" vivo="$4" intentado
  intentado="${FALLO_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo "${PREV:-}")}"
  {
    echo "fecha: $(date -Is)"
    echo "fase: $fase"
    echo "commit_intentado: $intentado"
    echo "commit_intentado_corto: $(git rev-parse --short "$intentado" 2>/dev/null || echo "$intentado")"
    echo "commit_revertido: ${LAST_GOOD:-}"
    echo "commit_revertido_corto: $(git rev-parse --short "${LAST_GOOD:-HEAD}" 2>/dev/null || echo "${LAST_GOOD:-}")"
    echo "revertido: $revertido"
    echo "servicio_vivo: $vivo"
    echo "registro: $LOG_FICHERO"
    echo "mensaje: $mensaje"
    echo "---extracto---"
    if [ -n "${FALLO_EXTRACTO:-}" ]; then
      printf '%s\n' "$FALLO_EXTRACTO"
    else
      echo "(sin extracto)"
    fi
  } > "$FALLO_FICHERO" 2>/dev/null \
    || log "AVISO: no pude escribir el post-mortem en $FALLO_FICHERO"
}

# Una actualización que sale bien borra el post-mortem anterior: si sigue ahí,
# es que sigue habiendo algo pendiente de mirar.
olvidar_fallo() { rm -f "$FALLO_FICHERO"; }

# ---------------------------------------------------------------
# Barreras 4a y 4b: pruebas y arranque REAL, antes de tocar el servicio.
# Se usan en los DOS caminos: cuando hay código nuevo que traer y cuando el
# servicio simplemente va por detrás del repositorio. En el segundo caso es
# fácil pensar que "no hay nada que verificar", pero es justo al contrario:
# un cambio hecho a mano puede romper la interfaz sin romper la API, y un
# health check no lo detectaría. Por eso se verifican siempre.
# ---------------------------------------------------------------
verificar_codigo() {
  # Dónde falló, con qué salida y con qué commit: lo usará el post-mortem.
  # El commit se fija AQUÍ, al fallar, y no al registrar: en medio puede haber
  # una reversión, y entonces HEAD ya no sería el que falló.
  FALLO_FASE=""
  FALLO_EXTRACTO=""
  FALLO_COMMIT=""
  local salida
  salida="$(mktemp)"

  log "Barrera 4a: ejecutando la suite de pruebas..."
  # Se ve en directo en el registro y a la vez se guarda para el post-mortem.
  # Margen amplio a propósito: en la Pi la suite tarda ~25 s, pero bajo presión de
  # memoria se ha visto dispararse. Un falso rechazo por lentitud —dejar sin
  # actualizar código que está bien— es peor que esperar de más. El tope real lo
  # pone TimeoutStartSec de la unidad (900 s).
  if ! timeout 600 npm test 2>&1 | tee -a "$LOG_FICHERO" > "$salida"; then
    FALLO_FASE="4a-pruebas"
    FALLO_EXTRACTO="$(tail -n 40 "$salida")"
    FALLO_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
    rm -f "$salida"
    log "Las pruebas FALLAN con este código."
    return 1
  fi
  rm -f "$salida"
  log "Barrera 4a OK: pruebas en verde."

  log "Barrera 4b: comprobando que el servidor arranca de verdad..."
  local brain_temporal smoke_pid arranca
  brain_temporal="$(mktemp -d)"
  salida="$(mktemp)"
  JARVIS_PORT="$SMOKE_PORT" JARVIS_BRAIN_DIR="$brain_temporal" \
    node src/index.js > "$salida" 2>&1 &
  smoke_pid=$!

  arranca=0
  for _ in $(seq 1 15); do
    sleep 1
    if curl -fsS --max-time 2 "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1; then
      arranca=1
      break
    fi
    kill -0 "$smoke_pid" 2>/dev/null || break
  done
  kill "$smoke_pid" 2>/dev/null
  wait "$smoke_pid" 2>/dev/null
  rm -rf "$brain_temporal"
  cat "$salida" >> "$LOG_FICHERO"

  if [ "$arranca" -ne 1 ]; then
    # La salida del arranque es EXACTAMENTE lo que hace falta para diagnosticar:
    # un error de sintaxis, un puerto ocupado, una dependencia que falta.
    FALLO_FASE="4b-arranque"
    FALLO_EXTRACTO="$(tail -n 40 "$salida")"
    FALLO_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
    rm -f "$salida"
    log "El servidor NO arranca con este código."
    return 1
  fi
  rm -f "$salida"
  log "Barrera 4b OK: el servidor arranca y responde."
  return 0
}

# Se quita la bandera al salir por cualquier vía, incluidos los errores. Si no,
# systemd no volvería a disparar el .path nunca más.
limpiar_bandera() {
  if [ -e "$BANDERA" ]; then
    rm -f "$BANDERA" && log "Bandera retirada; el .path queda armado de nuevo."
  fi
}
trap limpiar_bandera EXIT

# ---------------------------------------------------------------
# Volver el CÓDIGO a un commit anterior.
# ---------------------------------------------------------------
# Se llama en cuatro sitios y es la pieza que sostiene toda la promesa de
# "si algo falla, revierte sola". Hasta ahora NO ESTABA DEFINIDA: el script
# decía "se ha vuelto a X" y "✅ Revertido y funcionando" sin revertir nada,
# porque bash sólo avisa de una función inexistente cuando llega a ejecutarla.
# Y sólo se ejecuta cuando algo ha ido mal, así que no se notó nunca.
#
# --hard porque hay que deshacer un fast-forward ya aplicado. No se pierde nada:
# el árbol estaba limpio (barrera 1) y lo que se deshace ya está en origin
# (barrera 3) y en el respaldo (barrera 2).
revertir_codigo() {
  local destino="${1:-}"
  if [ -z "$destino" ]; then
    log "ERROR: no me han dicho a qué commit revertir."
    return 1
  fi
  if ! git cat-file -e "${destino}^{commit}" 2>/dev/null; then
    log "ERROR: el commit $destino no existe; no puedo revertir."
    return 1
  fi
  log "Revirtiendo el código a $(git rev-parse --short "$destino")..."
  if ! git reset --hard "$destino" >>"$LOG_FICHERO" 2>&1; then
    log "ERROR: 'git reset --hard $destino' falló. El código NO se ha revertido."
    return 1
  fi
  log "Código de vuelta en $(git rev-parse --short HEAD)."
  return 0
}

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
# ¿Está al día la COPIA INSTALADA del actualizador?
# ---------------------------------------------------------------
# Este script no puede actualizarse a sí mismo: systemd ejecuta la copia de
# /usr/local/sbin, que es de root, y aquí se corre como usuario normal. Un cambio
# en este fichero NO llega solo: hay que reinstalarlo.
#
# Y como nada lo comprobaba, la copia instalada podía quedarse vieja —con sus
# bugs incluidos— sin que nadie se enterara. Se AVISA, pero no se aborta:
# negarse a actualizar dejaría el sistema congelado, que es peor que hacerlo con
# una versión antigua del actualizador.
avisar_si_actualizador_desfasado() {
  local origen="$CODE_DIR/scripts/autoactualizar.sh"
  [ -f "$origen" ] || return 0
  [ -f "$INSTALADO" ] || return 0
  # Si resulta que se está ejecutando justo esta copia, no hay nada que comparar.
  if [ "$(readlink -f "$origen" 2>/dev/null)" = "$(readlink -f "$INSTALADO" 2>/dev/null)" ]; then
    return 0
  fi
  if cmp -s "$origen" "$INSTALADO"; then
    return 0
  fi

  log "⚠️  AVISO: el ACTUALIZADOR INSTALADO no coincide con el del repositorio."
  log "    instalado   : $INSTALADO"
  log "    repositorio : $origen"
  log "    No se actualiza solo (es una copia de root, y a propósito)."
  log "    Para ponerlo al día:  sudo bash $CODE_DIR/deploy/instalar.sh --autoupdate"
  bitacora "AVISO: el actualizador instalado está desfasado. Hace falta: sudo bash deploy/instalar.sh --autoupdate"
  return 0
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
if [ "$MODO" = "actualizar" ] && [ ! -e "$BANDERA" ]; then
  log "AVISO: no hay bandera en $BANDERA. Se continúa (ejecución manual)."
fi

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

# Se comprueba en TODOS los modos, también en --check y --rollback: es
# precisamente lo que antes nadie miraba.
avisar_si_actualizador_desfasado

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
ERROR_FETCH="$(git fetch origin "$BRANCH" 2>&1 >/dev/null)" || {
  log "Detalle del error de git:"; echo "$ERROR_FETCH" | head -3 | while read -r l; do log "  $l"; done
  if echo "$ERROR_FETCH" | grep -q "Host key verification failed"; then
    morir "falta la clave de host en ~/.ssh/known_hosts. Arrégialo con: sudo bash deploy/instalar.sh --backup"
  fi
  morir "no pude contactar con el remoto"
}
REMOTE="$(git rev-parse "origin/$BRANCH")"

# Hay un caso que "no hay nada que traer" no cubre: que el repositorio ya esté
# al día pero el SERVICIO siga ejecutando código anterior. Pasa siempre que se
# commitea desde la propia máquina (aquí el taller y el despliegue son el mismo
# sitio), y sin esto el servicio se quedaría viejo para siempre.
REINICIO_PENDIENTE=0
ESTADO_API="$(curl -fsS --max-time 5 "$STATUS_URL" 2>/dev/null || true)"
if echo "$ESTADO_API" | grep -q '"reinicioPendiente": *true'; then
  REINICIO_PENDIENTE=1
fi

# ---------------------------------------------------------------
# Relación REAL entre lo local y el remoto
# ---------------------------------------------------------------
# Hay TRES relaciones, no dos, y confundir "por delante" con "divergido" fue un
# fallo real: en cuanto se commiteaba desde esta máquina —justo lo que hace la
# automodificación— el actualizador se negaba para siempre. Y como esta
# comprobación estaba ANTES del respaldo, esos commits tampoco se subían nunca:
# bloqueo definitivo, con trabajo real sin respaldar.
if [ "$PREV" = "$REMOTE" ]; then
  RELACION="igual"
elif git merge-base --is-ancestor "$PREV" "$REMOTE" 2>/dev/null; then
  RELACION="detras"      # el remoto trae commits nuevos: fast-forward limpio
elif git merge-base --is-ancestor "$REMOTE" "$PREV" 2>/dev/null; then
  RELACION="delante"     # commits locales sin subir: NO es una divergencia
else
  RELACION="divergido"   # cada lado tiene commits que el otro no tiene
fi

if [ "$RELACION" = "divergido" ]; then
  morir "las ramas han divergido DE VERDAD: hay commits en local y en origin/$BRANCH que no están en el otro. No se toca nada para no perderlos; resuélvelo a mano."
fi

if [ "$RELACION" = "delante" ]; then
  PENDIENTES="$(git rev-list --count "origin/$BRANCH..HEAD")"
  log "Local va $PENDIENTES commit(s) por delante de origin/$BRANCH (no es divergencia: aquí está todo lo del remoto)."
  if [ "$MODO" = "check" ]; then
    log "(--check: hay $PENDIENTES commit(s) locales sin subir)"
    exit 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "(simulación) se subirían los $PENDIENTES commit(s) locales y, si procede, se reiniciaría."
    exit 0
  fi
  # Se respaldan ANTES de nada más: son trabajo real, y el respaldo existe
  # precisamente para que no dependan de esta tarjeta SD.
  log "Respaldando los commits locales en origin/$BRANCH..."
  if ! JARVIS_BRAIN_DIR="$BRAIN_DIR" bash "$CODE_DIR/scripts/backup.sh" \
         "chore: respaldo de commits locales antes de actualizar" >>"$LOG_FICHERO" 2>&1; then
    morir "no pude subir los commits locales. El servicio no se toca."
  fi
  REMOTE="$(git rev-parse "origin/$BRANCH")"
  log "Commits locales respaldados; origin/$BRANCH en $(git rev-parse --short "$REMOTE")."
fi

if [ "$REMOTE" = "$PREV" ] && [ "$REINICIO_PENDIENTE" -eq 0 ]; then
  log "Ya está al día ($(git rev-parse --short "$PREV"))."
  exit 0
fi

if [ "$REMOTE" = "$PREV" ]; then
  log "El repositorio está al día, pero el servicio ejecuta código anterior."
    log "Hay que VERIFICAR ese codigo antes de reiniciar: puede haberlo"
    log "cambiado un agente, y una interfaz rota no la detecta un health check."
  if [ "$MODO" = "check" ]; then
    log "(--check: hay un reinicio pendiente)"
    exit 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "(simulación) se reiniciaría el servicio."
    exit 0
  fi

    if ! verificar_codigo; then
      # El servicio NO se toca: sigue con lo que ya tenia cargado y funcionaba.
      # Se devuelve el repositorio al ultimo commit bueno.
      revertir_codigo "$LAST_GOOD"
      registrar_fallo "${FALLO_FASE:-4-verificacion}" \
        "el código del repositorio no pasa la verificación" "si" "si"
      bitacora "RECHAZADO el codigo sin verificar; se vuelve a $(git rev-parse --short "$LAST_GOOD")"
      morir "el codigo del repositorio no pasa la verificacion. El servicio sigue intacto y el codigo se ha devuelto a $(git rev-parse --short "$LAST_GOOD")."
    fi

  if reiniciar_y_verificar; then
    echo "$(git rev-parse HEAD)" > "$LAST_GOOD_FILE"
    olvidar_fallo
    log "✅ Servicio reiniciado con el código al día ($(git rev-parse --short HEAD))."
    bitacora "OK · reinicio para aplicar $(git rev-parse --short HEAD)"
    exit 0
  fi
  log "El servicio no responde tras el reinicio. Se intenta volver a $(git rev-parse --short "$LAST_GOOD")..."
  revertir_codigo "$LAST_GOOD"
  if reiniciar_y_verificar; then
    log "Revertido a $(git rev-parse --short "$LAST_GOOD") y funcionando."
    registrar_fallo "5-reinicio" \
      "el servicio no respondió tras reiniciar; se revirtió y volvió a funcionar" "si" "si"
  else
    log "🚨 CRÍTICO: ni con el commit probado arranca. Intervención manual."
    registrar_fallo "5-reinicio" \
      "el servicio no respondió tras reiniciar y tampoco tras revertir" "si" "no"
  fi
  exit 1
fi

# A estas alturas la relación sólo puede ser "detrás": "igual" y "por delante"
# salen por arriba, y "divergido" aborta antes de tocar nada. Se deja como
# guarda: es el fichero más delicado del proyecto.
if [ "${RELACION:-}" != "detras" ]; then
  morir "estado inesperado de las ramas ('${RELACION:-desconocido}'). No se toca nada."
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
# ---------------------------------------------------------------
log "Verificando el código nuevo antes de tocar nada..."
if ! verificar_codigo; then
  revertir_codigo "$PREV"
  registrar_fallo "${FALLO_FASE:-4-verificacion}" \
    "el código nuevo no pasa la verificación" "si" "si"
  morir "el código nuevo no pasa la verificación. Se ha vuelto a $(git rev-parse --short "$PREV") y Jarvis sigue con lo anterior, intacto."
fi

# ---------------------------------------------------------------
# BARRERA 5 · Reiniciar el servicio y comprobar de verdad
# ---------------------------------------------------------------
if reiniciar_y_verificar; then
  echo "$(git rev-parse HEAD)" > "$LAST_GOOD_FILE"
  olvidar_fallo
  log "✅ Actualización completada. Nuevo ancla: $(git rev-parse --short HEAD)"
  bitacora "OK · actualizado de $(git rev-parse --short "$PREV") a $(git rev-parse --short HEAD)"
  exit 0
fi

log "El servicio no responde con el código nuevo. Iniciando REVERSIÓN..."
bitacora "El código nuevo no arrancó; revirtiendo a $(git rev-parse --short "$LAST_GOOD")"
revertir_codigo "$LAST_GOOD"

if reiniciar_y_verificar; then
  log "✅ Revertido a $(git rev-parse --short "$LAST_GOOD") y funcionando."
  registrar_fallo "5-reinicio" \
    "el código nuevo no arrancó; se revirtió y el servicio volvió a funcionar" "si" "si"
  bitacora "REVERTIDO a $(git rev-parse --short "$LAST_GOOD") y funcionando"
  exit 1
fi

log "🚨 CRÍTICO: ni con el commit probado arranca el servicio."
log "   Intervención manual necesaria. Estado:"
log "     código en $(git rev-parse --short HEAD)"
log "     último bueno $(git rev-parse --short "$LAST_GOOD")"
log "     log completo en $LOG_FICHERO"
registrar_fallo "5-reinicio" \
  "ni con el commit probado arranca el servicio" "si" "no"
bitacora "CRÍTICO: ni con el commit probado arranca. Hace falta intervención manual."
exit 2
