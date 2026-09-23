#!/usr/bin/env bash
# ============================================================
#  Jarvis · mantenimiento a mano
# ------------------------------------------------------------
#  Las operaciones que necesitan root, con nombres que se
#  recuerdan, en un solo sitio. NO hace nada por su cuenta: es
#  una envoltura de deploy/instalar.sh, del actualizador y del
#  registro. Cada orden imprime exactamente lo que ejecuta.
#
#  Uso:
#     sudo ./mantenimiento.sh estado
#     sudo ./mantenimiento.sh actualizador
#     sudo ./mantenimiento.sh actualizar
#
#  Para tenerlo siempre a mano en tu carpeta (esto NO necesita sudo):
#     ./mantenimiento.sh instalar
# ============================================================
set -uo pipefail

# Configuración: se lee la del sistema si existe (la deja `instalar.sh` con los
# valores ya resueltos) y, si no, se deduce de dónde esté este script.
[ -f /etc/jarvis/jarvis.conf ] && . /etc/jarvis/jarvis.conf

AQUI="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_DEDUCIDO="$(cd "$(dirname "$AQUI")/.." && pwd)"
REPO_DIR="${JARVIS_CODE_DIR:-$REPO_DEDUCIDO}"
BASE_DIR="$(dirname "$REPO_DIR")"

USUARIO="${JARVIS_USER:-$(id -un)}"
PUERTO="${JARVIS_PORT:-3081}"
ESTADO_DIR="${JARVIS_UPDATE_STATE:-$BASE_DIR/.update-state}"
REGISTRO="$ESTADO_DIR/autoactualizacion.log"
LAST_GOOD="$ESTADO_DIR/last-good"
FALLO="$ESTADO_DIR/ultimo-fallo.txt"
INSTALADO="${JARVIS_UPDATER_INSTALLED:-${JARVIS_SBIN_DIR:-/usr/local/sbin}/jarvis-actualizar}"
BANDERA="${JARVIS_UPDATE_FLAG:-$BASE_DIR/.update-request}"
SERVICIO="${JARVIS_SERVICE:-jarvis.service}"
SALUD="${JARVIS_SALUD_URL:-http://127.0.0.1:$PUERTO/api/system/status}"
BRAIN_DIR="${JARVIS_BRAIN_DIR:-$BASE_DIR/jarvis-vault}"
CASA_USUARIO="$(getent passwd "$USUARIO" 2>/dev/null | cut -d: -f6)"
[ -n "$CASA_USUARIO" ] || CASA_USUARIO="$HOME"
DESTINO="${JARVIS_MANTENIMIENTO:-$CASA_USUARIO/mantenimiento.sh}"

info()  { printf '  %s\n' "$*"; }
paso()  { printf '\n▶ %s\n' "$*"; }
error() { printf 'ERROR: %s\n' "$*" >&2; }

uso() {
  cat <<'EOF'
Órdenes:
  estado         Resumen: versiones, servicio, y si el actualizador instalado
                 coincide con el del repositorio. Empieza siempre por aquí.
  actualizador   Reinstala las unidades y el ayudante del actualizador
                 (deploy/instalar.sh --autoupdate). El script del actualizador
                 como tal ya se refresca solo en cada actualización.
  servicio       Reinstala y arranca jarvis.service (--jarvis).
  parar          Para el servicio.
  arrancar       Arranca el servicio.
  reiniciar      Reinicia el servicio, sin actualizar nada.
  respaldo       Respalda los dos repositorios ahora, y SÍ commitea el código.
                 (El temporizador automático sólo sube lo ya commiteado.)
  actualizar     Dispara la actualización y espera a que termine.
  revertir       Vuelve al último commit bueno.
  fallo          Muestra el post-mortem de la última actualización fallida.
  registro       Últimas 60 líneas del registro del actualizador.
  todo           Todo lo instalable (--all). Para una instalación completa.
  instalar       Copia este script a ~/mantenimiento.sh para tenerlo a mano.
  ayuda          Esta ayuda.
EOF
}

# El repositorio y el estado son del usuario jarvis, no de root. Si esto se
# ejecuta con sudo hay que bajar de privilegio, o los commits y la bandera
# quedarían con dueño root y jarvis no podría ni borrar la bandera (con lo que
# el .path de systemd no volvería a dispararse nunca).
como_jarvis() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$USUARIO" -- "$@"
  else
    "$@"
  fi
}

necesita_root() {
  if [ "$(id -u)" -eq 0 ]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    echo "Esta orden necesita root; se reejecuta con sudo."
    exec sudo bash "$AQUI" "$@"
  fi
  error "esta orden necesita root y no hay sudo disponible."
  exit 1
}

# ---------------------------------------------------------------
orden_estado() {
  paso "Versiones"
  info "$(printf '%-24s' 'repositorio (git HEAD)') $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  info "$(printf '%-24s' 'rama') $(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  info "$(printf '%-24s' 'áncora (último bueno)') $(cut -c1-7 "$LAST_GOOD" 2>/dev/null || echo '(ninguna)')"
  info "$(printf '%-24s' 'árbol de trabajo') $([ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ] && echo 'CON CAMBIOS sin commitear' || echo 'limpio')"

  local api
  api="$(curl -fsS --max-time 5 "$SALUD" 2>/dev/null || true)"
  if [ -n "$api" ]; then
    info "$(printf '%-24s' 'en marcha (servicio)') $(echo "$api" | grep -o '"runningCommitCorto": *"[^"]*"' | cut -d'"' -f4)"
    info "$(printf '%-24s' 'reinicio pendiente') $(echo "$api" | grep -o '"reinicioPendiente": *[a-z]*' | awk '{print $2}')"
  else
    info "$(printf '%-24s' 'en marcha (servicio)') (no responde en $SALUD)"
  fi
  info "$(printf '%-24s' 'jarvis.service') $(systemctl is-active "$SERVICIO" 2>/dev/null || echo 'desconocido')"

  paso "Actualizador instalado"
  local origen="$REPO_DIR/scripts/autoactualizar.sh"
  if [ ! -f "$INSTALADO" ]; then
    info "✗ no está instalado en $INSTALADO"
    info "  → sudo bash $REPO_DIR/deploy/instalar.sh --autoupdate"
  elif cmp -s "$origen" "$INSTALADO"; then
    info "✓ al día (idéntico a scripts/autoactualizar.sh)"
  else
    info "⚠ DESFASADO respecto al repositorio"
    info "  instalado:   $INSTALADO"
    info "  repositorio: $origen"
    info "  Se pondrá al día solo en la próxima actualización."
    info "  Para forzarlo ahora:  sudo bash $REPO_DIR/deploy/instalar.sh --autoupdate"
  fi

  paso "Bandera de actualización"
  if [ -e "$BANDERA" ]; then
    info "presente en $BANDERA (¿actualización en curso o atascada?)"
  else
    info "no hay ninguna (correcto)"
  fi

  paso "Último fallo"
  if [ -f "$FALLO" ]; then
    info "⚠ hay un post-mortem SIN RESOLVER"
    info "  míralo con:  $0 fallo"
  else
    info "ninguno (la última actualización salió bien)"
  fi
}

orden_actualizador() {
  necesita_root "$@"
  paso "Reinstalando el actualizador"
  bash "$REPO_DIR/deploy/instalar.sh" --autoupdate
}

orden_servicio() {
  necesita_root "$@"
  paso "Reinstalando el servicio"
  bash "$REPO_DIR/deploy/instalar.sh" --jarvis
}

orden_parar() {
  necesita_root "$@"
  paso "Parando $SERVICIO"
  systemctl stop "$SERVICIO"
  info "estado: $(systemctl is-active "$SERVICIO" 2>/dev/null || true)"
}

orden_arrancar() {
  necesita_root "$@"
  paso "Arrancando $SERVICIO"
  systemctl start "$SERVICIO"
  sleep 2
  info "estado: $(systemctl is-active "$SERVICIO" 2>/dev/null || true)"
}

orden_reiniciar() {
  necesita_root "$@"
  paso "Reiniciando $SERVICIO (sin actualizar nada)"
  systemctl restart "$SERVICIO"
  local i
  for i in $(seq 1 15); do
    sleep 2
    if curl -fsS --max-time 3 "$SALUD" >/dev/null 2>&1; then
      info "responde correctamente (intento $i)"
      return 0
    fi
  done
  error "no responde tras el reinicio. Mira: journalctl -u $SERVICIO -n 50"
  return 1
}

orden_fallo() {
  paso "Post-mortem de la última actualización fallida"
  if [ ! -f "$FALLO" ]; then
    info "no hay ninguno: la última actualización salió bien."
    return 0
  fi
  cat "$FALLO"
}

orden_todo() {
  necesita_root "$@"
  paso "Instalación completa"
  bash "$REPO_DIR/deploy/instalar.sh" --all
}

orden_respaldo() {
  paso "Respaldando los dos repositorios"
  # A mano SÍ se commitea el código: pedir un respaldo es exactamente decir
  # "guarda lo que tengo ahora". El temporizador automático, en cambio, sólo sube
  # lo que ya esté commiteado, para no ensuciar la historia del repositorio
  # público con el trabajo a medias de un agente.
  como_jarvis env JARVIS_BRAIN_DIR="$BRAIN_DIR" \
    JARVIS_BACKUP_COMMIT_CODE=1 \
    bash "$REPO_DIR/scripts/backup.sh" "chore: respaldo manual"
}

orden_actualizar() {
  paso "Disparando la actualización"
  # La bandera la crea jarvis, NUNCA root: si queda con dueño root, el
  # actualizador no puede borrarla y el .path de systemd no vuelve a dispararse.
  como_jarvis touch "$BANDERA"
  info "bandera puesta; systemd lanzará el actualizador"

  local espera=0
  while [ -e "$BANDERA" ] && [ "$espera" -lt 300 ]; do
    sleep 2
    espera=$((espera + 2))
    printf '\r  esperando al actualizador... %ss ' "$espera"
  done
  printf '\n'

  if [ -e "$BANDERA" ]; then
    error "la bandera sigue ahí tras 300s. El actualizador no ha corrido."
    info "Comprueba:  systemctl status jarvis-autoupdate.path"
  else
    info "el actualizador terminó. Últimas líneas:"
  fi
  orden_registro
}

orden_revertir() {
  necesita_root "$@"
  paso "Revirtiendo al último commit bueno"
  # Se le pasan las rutas explícitamente: la copia instalada vive en el
  # directorio de binarios y no puede deducir de ahí dónde está el repositorio.
  # Así funciona aunque todavía no exista /etc/jarvis/jarvis.conf.
  como_jarvis env \
    JARVIS_CODE_DIR="$REPO_DIR" \
    JARVIS_BRAIN_DIR="$BRAIN_DIR" \
    JARVIS_UPDATE_STATE="$ESTADO_DIR" \
    JARVIS_UPDATE_FLAG="$BANDERA" \
    "$INSTALADO" --rollback
}

orden_registro() {
  paso "Registro del actualizador ($REGISTRO)"
  if [ -f "$REGISTRO" ]; then
    tail -n 60 "$REGISTRO"
  else
    info "(todavía no hay registro)"
  fi
}

orden_instalar() {
  paso "Creando la copia a mano en $DESTINO"
  # La copia lleva las rutas DENTRO, para que siga sirviendo desde ~ sin depender
  # de la configuración del sistema. Es una herramienta de rescate: tiene que
  # funcionar justo cuando lo demás va mal.
  {
    head -1 "$AQUI"          # el shebang del original
    echo "# ---- Rutas fijadas al crear esta copia ($(date '+%Y-%m-%d %H:%M')) ----"
    echo "JARVIS_CODE_DIR=\"$REPO_DIR\""
    echo "JARVIS_BRAIN_DIR=\"$BRAIN_DIR\""
    echo "JARVIS_UPDATE_STATE=\"$ESTADO_DIR\""
    echo "JARVIS_UPDATE_FLAG=\"$BANDERA\""
    echo "JARVIS_SBIN_DIR=\"$(dirname "$INSTALADO")\""
    echo "JARVIS_USER=\"$USUARIO\""
    echo "JARVIS_PORT=\"$PUERTO\""
    echo "# ----------------------------------------------------------------------"
    tail -n +2 "$AQUI"       # el resto del original
  } > "$DESTINO"
  chmod 0755 "$DESTINO"
  if [ "$(id -u)" -eq 0 ]; then
    chown "$USUARIO:$USUARIO" "$DESTINO" 2>/dev/null || true
  fi
  info "listo. Ya puedes ejecutarlo con:  $DESTINO estado"
  info "Es una copia autocontenida: lleva las rutas dentro y funciona desde ~."
  info "Si cambia el del repositorio, vuelve a ejecutar esta orden."
}

case "${1:-ayuda}" in
  estado)       orden_estado ;;
  actualizador) orden_actualizador "$@" ;;
  servicio)     orden_servicio "$@" ;;
  parar)        orden_parar "$@" ;;
  arrancar)     orden_arrancar "$@" ;;
  reiniciar)    orden_reiniciar "$@" ;;
  respaldo)     orden_respaldo ;;
  actualizar)   orden_actualizar ;;
  revertir)     orden_revertir "$@" ;;
  fallo)        orden_fallo ;;
  registro)     orden_registro ;;
  todo)         orden_todo "$@" ;;
  instalar)     orden_instalar ;;
  ayuda|-h|--help) uso ;;
  *) error "orden desconocida: $1"; echo; uso; exit 1 ;;
esac
