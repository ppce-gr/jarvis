#!/usr/bin/env bash
# ============================================================
#  Jarvis · instalación de los componentes de sistema
# ------------------------------------------------------------
#  Este script lo ejecuta EL USUARIO con sudo. El agente que
#  preparó el repositorio no puede tocar /etc ni instalar global
#  (su entorno monta el sistema de ficheros en solo lectura).
#
#  Es idempotente: puedes ejecutarlo varias veces.
#  Soporta --dry-run para ver qué haría sin tocar nada.
#
#  Uso:
#     sudo bash deploy/instalar.sh --dry-run --all
#     sudo bash deploy/instalar.sh --zram
#     sudo bash deploy/instalar.sh --jarvis --backup --dsh-global
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.3}"

DRY_RUN=0
DO_ZRAM=0
DO_JARVIS=0
DO_BACKUP=0
DO_DSH_GLOBAL=0
DO_AUTOUPDATE=0

uso() {
  cat <<'EOF'
Opciones:
  --zram         Activa swap comprimido en RAM (zram) + swappiness.
                 Recomendado: ataca el swap de 493 MB que hoy escribe en la SD.
  --jarvis       Instala y arranca el servicio jarvis.service (puerto 3081).
  --backup       Instala el temporizador de respaldo Git cada 30 minutos.
  --dsh-global   Instala el CLI dsh global con versión fijada (recomendado).
  --autoupdate   Instala la AUTOACTUALIZACIÓN con reversión: copia el
                 actualizador fuera del repositorio, las unidades systemd y la
                 regla de sudoers que le permite reiniciar sólo jarvis.
                 REQUIERE que --jarvis esté aplicado.
  --all          Equivale a --zram --jarvis --backup --dsh-global --autoupdate
  --dry-run      Muestra los comandos sin ejecutarlos.
  -h, --help     Esta ayuda.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --zram)       DO_ZRAM=1 ;;
    --jarvis)     DO_JARVIS=1 ;;
    --backup)     DO_BACKUP=1 ;;
    --dsh-global) DO_DSH_GLOBAL=1 ;;
    --autoupdate) DO_AUTOUPDATE=1 ;;
    --all)        DO_ZRAM=1; DO_JARVIS=1; DO_BACKUP=1; DO_DSH_GLOBAL=1; DO_AUTOUPDATE=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    uso; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; uso; exit 1 ;;
  esac
done

if [ "$((DO_ZRAM + DO_JARVIS + DO_BACKUP + DO_DSH_GLOBAL + DO_AUTOUPDATE))" -eq 0 ]; then
  uso; exit 1
fi

# ---------------------------------------------------------------
# Configuración: quién, dónde y en qué puertos
# ---------------------------------------------------------------
# Precedencia: deploy/jarvis.conf (lo que eligió el desarrollador) → la copia ya
# instalada en /etc (lo que está en marcha) → valores deducidos de dónde esté
# este repositorio. Así un clon con la bóveda al lado funciona SIN configurar
# nada, y el fichero sólo hace falta para salirse de lo normal.
CONF_REPO="$REPO_DIR/deploy/jarvis.conf"
CONF_SISTEMA="/etc/jarvis/jarvis.conf"
if [ -f "$CONF_REPO" ]; then
  . "$CONF_REPO";    CONF_USADA="$CONF_REPO"
elif [ -f "$CONF_SISTEMA" ]; then
  . "$CONF_SISTEMA"; CONF_USADA="$CONF_SISTEMA"
else
  CONF_USADA="(ninguna: se deducen del entorno)"
fi

JARVIS_USER="${JARVIS_USER:-${SUDO_USER:-$(id -un)}}"
JARVIS_GROUP="${JARVIS_GROUP:-$(id -gn "$JARVIS_USER" 2>/dev/null || echo "$JARVIS_USER")}"
JARVIS_HOME="$(getent passwd "$JARVIS_USER" 2>/dev/null | cut -d: -f6)"
JARVIS_HOME="${JARVIS_HOME:-/home/$JARVIS_USER}"

# La disposición natural: el repositorio donde está, y la memoria y el estado
# como hermanos suyos.
BASE_DIR="$(dirname "$REPO_DIR")"
JARVIS_CODE_DIR="${JARVIS_CODE_DIR:-$REPO_DIR}"
JARVIS_BRAIN_DIR="${JARVIS_BRAIN_DIR:-$BASE_DIR/jarvis-vault}"
JARVIS_UPDATE_STATE="${JARVIS_UPDATE_STATE:-$BASE_DIR/.update-state}"
JARVIS_UPDATE_FLAG="${JARVIS_UPDATE_FLAG:-$BASE_DIR/.update-request}"
JARVIS_PORT="${JARVIS_PORT:-3081}"
JARVIS_HOST="${JARVIS_HOST:-0.0.0.0}"
JARVIS_SMOKE_PORT="${JARVIS_SMOKE_PORT:-3099}"
JARVIS_SBIN_DIR="${JARVIS_SBIN_DIR:-/usr/local/sbin}"
JARVIS_NODE_BIN="${JARVIS_NODE_BIN:-$(command -v node 2>/dev/null || echo /usr/bin/node)}"
JARVIS_MANTENIMIENTO="${JARVIS_MANTENIMIENTO:-$JARVIS_HOME/mantenimiento.sh}"
JARVIS_DSH_PROFILE="${JARVIS_DSH_PROFILE:-headless}"
JARVIS_CHAT_PROTOCOL="${JARVIS_CHAT_PROTOCOL:-acp}"
JARVIS_CHAT_PROFILE="${JARVIS_CHAT_PROFILE:-acp}"
JARVIS_CHAT_PROVIDER="${JARVIS_CHAT_PROVIDER:-deepseek-official}"
JARVIS_CHAT_MODEL="${JARVIS_CHAT_MODEL:-deepseek-v4-flash}"
JARVIS_CHAT_EFFORT="${JARVIS_CHAT_EFFORT:-high}"
JARVIS_CHAT_IDLE_MS="${JARVIS_CHAT_IDLE_MS:-900000}"
JARVIS_BACKUP_COMMIT_CODE="${JARVIS_BACKUP_COMMIT_CODE:-0}"
JARVIS_BRANCH="${JARVIS_BRANCH:-main}"
# JARVIS_DSH_BIN se resuelve más abajo, en la sección de DSH.
JARVIS_DSH_BIN="${JARVIS_DSH_BIN:-}"

echo "== 0/6 · configuración ($CONF_USADA) =="
echo "   usuario:   $JARVIS_USER ($JARVIS_GROUP) · casa $JARVIS_HOME"
echo "   código:    $JARVIS_CODE_DIR"
echo "   memoria:   $JARVIS_BRAIN_DIR"
echo "   estado:    $JARVIS_UPDATE_STATE"
echo "   puertos:   $JARVIS_PORT (prueba $JARVIS_SMOKE_PORT)"
echo "   binarios:  $JARVIS_SBIN_DIR"
echo

# ---------------------------------------------------------------
# Renderizar una plantilla de systemd
# ---------------------------------------------------------------
# Las unidades NO pueden leer un .env: `User=`, `WorkingDirectory=` y
# `PathExists=` no expanden variables, y `EnvironmentFile=` sólo sirve para los
# procesos. Por eso son plantillas y se rellenan aquí, con los valores resueltos.
renderizar() {   # $1 plantilla · $2 destino
  local plantilla="$1" destino="$2" contenido var
  contenido="$(cat "$plantilla")"
  for var in JARVIS_USER JARVIS_GROUP JARVIS_HOME JARVIS_CODE_DIR JARVIS_BRAIN_DIR \
             JARVIS_UPDATE_STATE JARVIS_UPDATE_FLAG JARVIS_PORT JARVIS_HOST \
             JARVIS_SMOKE_PORT JARVIS_SBIN_DIR JARVIS_NODE_BIN JARVIS_DSH_BIN \
             JARVIS_DSH_PROFILE JARVIS_CHAT_PROTOCOL JARVIS_CHAT_PROFILE \
             JARVIS_CHAT_PROVIDER JARVIS_CHAT_MODEL JARVIS_CHAT_EFFORT \
             JARVIS_CHAT_IDLE_MS JARVIS_BACKUP_COMMIT_CODE JARVIS_BRANCH; do
    contenido="${contenido//@${var}@/${!var:-}}"
  done
  # Si queda algún marcador es que la plantilla pide algo que no hemos resuelto:
  # mejor fallar aquí que instalar una unidad con @ALGO@ dentro.
  if printf '%s\n' "$contenido" | grep -q '@JARVIS_'; then
    echo "  ERROR: quedaron marcadores sin sustituir en $plantilla:" >&2
    printf '%s\n' "$contenido" | grep -o '@JARVIS_[A-Z_]*@' | sort -u | sed 's/^/         /' >&2
    return 1
  fi
  printf '%s\n' "$contenido" > "$destino"
}

instalar_unidad() {   # $1 nombre del fichero sin la extensión
  # En dos líneas a propósito: dentro de un mismo `local`, bash no garantiza que
  # la primera variable ya esté asignada al evaluar la segunda.
  local nombre="$1"
  local plantilla="$REPO_DIR/deploy/systemd/$nombre.in"
  if [ ! -f "$plantilla" ]; then
    echo "  ERROR: falta la plantilla $plantilla" >&2
    return 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $nombre.in → /etc/systemd/system/$nombre"
    return 0
  fi
  renderizar "$plantilla" "/etc/systemd/system/$nombre" \
    && echo "  + unidad escrita en /etc/systemd/system/$nombre"
}

# Copia de los valores ya resueltos, para que los encuentren los comandos que se
# ejecutan a mano (el script de mantenimiento, el actualizador sin systemd). El
# estilo ${VAR:-valor} deja que una variable de entorno siga ganando.
escribir_conf_sistema() {
  local var
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] valores resueltos → $CONF_SISTEMA"
    return 0
  fi
  mkdir -p "$(dirname "$CONF_SISTEMA")"
  {
    echo "# Generado por deploy/instalar.sh el $(date '+%Y-%m-%d %H:%M')."
    echo "# Valores ya resueltos de esta instalación. systemd no los necesita"
    echo "# (los lleva dentro de cada unidad): esto es para los comandos que se"
    echo "# ejecutan a mano. El estilo \${VAR:-valor} deja ganar al entorno."
    echo
    for var in JARVIS_USER JARVIS_GROUP JARVIS_CODE_DIR JARVIS_BRAIN_DIR \
               JARVIS_UPDATE_STATE JARVIS_UPDATE_FLAG JARVIS_PORT JARVIS_HOST \
               JARVIS_SMOKE_PORT JARVIS_SBIN_DIR JARVIS_NODE_BIN JARVIS_DSH_BIN \
               JARVIS_BACKUP_COMMIT_CODE JARVIS_BRANCH; do
      echo "${var}=\"\${${var}:-${!var:-}}\""
    done
  } > "$CONF_SISTEMA"
  chmod 0644 "$CONF_SISTEMA"
  echo "  + valores resueltos en $CONF_SISTEMA"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    echo "  + $*"
    "$@"
  fi
}

# Sin la clave de host de GitHub en ~/.ssh/known_hosts, SSH falla con
# "Host key verification failed" y TANTO el respaldo como la actualización
# fallan en silencio. Se usa la clave publicada por GitHub en su documentación
# oficial (no ssh-keyscan, que no verifica identidad).
#   https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

asegurar_known_hosts() {
  local usuario="${1:-$USER}"
  local home_dir
  home_dir="$(getent passwd "$usuario" | cut -d: -f6)"
  [ -n "$home_dir" ] || home_dir="$HOME"
  local kh="$home_dir/.ssh/known_hosts"

  if [ -f "$kh" ] && grep -q '^github\.com ' "$kh" 2>/dev/null; then
    echo "   known_hosts ya tiene github.com."
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] añadir la clave de host de GitHub a $kh"
    return 0
  fi

  mkdir -p "$home_dir/.ssh"
  printf '%s\n' "$GITHUB_HOST_KEY" >> "$kh"
  chmod 600 "$kh"
  chown "$usuario":"$usuario" "$kh" 2>/dev/null || true
  echo "   + clave de host de GitHub añadida a $kh"
}

requiere_root() {
  if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    echo "ERROR: ejecútame con sudo." >&2
    exit 1
  fi
}

requiere_root
echo "Repositorio: $REPO_DIR"
[ "$DRY_RUN" -eq 1 ] && echo "*** MODO SIMULACIÓN: no se cambia nada ***"
echo

# ------------------------------------------------------------
if [ "$DO_DSH_GLOBAL" -eq 1 ]; then
  echo "== 1/6 · CLI dsh global con versión fijada =="
  echo "   Motivo: 'npx @latest' consulta el registro en cada arranque,"
  echo "   puede actualizarse solo y rompe rutas al cambiar de versión."
  if command -v dsh >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    echo "   Ya existe: $(command -v dsh)"
  fi
  echo "   OJO con la versión: el paquete declara sus plugins con rangos ^, así"
  echo "   que instalar una versión ANTIGUA del core hace que npm traiga plugins"
  echo "   MÁS NUEVOS. Esa mezcla rompe el arranque con un error confuso"
  echo "   ('cannot create effect on inactive context'). Instala SIEMPRE la más"
  echo "   nueva de la familia, no una anterior."
  run npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"
  # Se acaba de instalar en global, así que ÉSA es la buena. Se fija aquí para
  # que la unidad la use aunque la configuración dijera otra cosa: pedir
  # --dsh-global es exactamente pedir la instalación global.
  PREFIJO_NPM="$(npm config get prefix 2>/dev/null || echo /usr/local)"
  JARVIS_DSH_BIN="$PREFIJO_NPM/bin/dsh"
  DSH_BIN_PATH="$JARVIS_DSH_BIN"
  echo "   Binario: $DSH_BIN_PATH"

  # Verificación de verdad: que DSH arranque y responda. Habría detectado el
  # desajuste de versiones en el acto en vez de dejar el servicio roto.
  if [ "$DRY_RUN" -eq 0 ] && [ -x "$DSH_BIN_PATH" ]; then
    echo "   Probando que DSH arranca y responde..."
    if DSH_HOME="${DSH_HOME:-$HOME/.dsh}" timeout 180 "$DSH_BIN_PATH" --profile headless \
         "Responde unicamente con OK" >/dev/null 2>&1; then
      echo "   OK: DSH funciona."
    else
      echo "   ERROR: DSH no arranca o no responde." >&2
      echo "   Suele ser un desajuste de versiones entre el core y sus plugins." >&2
      echo "   Comprueba con:  dsh --profile headless \"OK\"" >&2
    fi
  fi
  echo
fi

# ------------------------------------------------------------
if [ "$DO_ZRAM" -eq 1 ]; then
  echo "== 2/6 · zram con el gestor NATIVO de Raspberry Pi OS =="
  echo "   Motivo: cientos de MB de swap escribiendose en la SD."
  echo
  echo "   NO se usa systemd-zram-generator. Raspberry Pi OS ya trae"
  echo "   /usr/lib/systemd/zram-generator.conf.d/20-rpi-swap-zram0-ctrl.conf"
  echo "   con fs-type=none, que DESACTIVA zram a proposito: es rpi-swap"
  echo "   quien lo activa. Un fichero propio en /etc/ pisaria ese control"
  echo "   y rompe la cadena de dependencias (paso, comprobado)."
  echo
  # Limpieza de aquel intento fallido, si existe.
  if [ -f /etc/systemd/zram-generator.conf ]; then
    echo "   AVISO: existe /etc/systemd/zram-generator.conf (el intento"
    echo "   fallido). Se retira para restaurar la config del fabricante."
    run rm -f /etc/systemd/zram-generator.conf
  fi
  run mkdir -p /etc/rpi/swap.conf.d
  run cp "$REPO_DIR/deploy/rpi-swap-jarvis.conf" /etc/rpi/swap.conf.d/99-jarvis.conf
  run cp "$REPO_DIR/deploy/sysctl-swappiness.conf" /etc/sysctl.d/99-jarvis-memoria.conf
  # OJO: NO se reinicia rpi-resize-swap-file.service. Es parte del mecanismo de
  # FICHERO, que es justo el que se abandona, y al ejecutarse con /var/swap en
  # uso falla con "Text file busy". Basta con recargar y reiniciar la maquina.
  run systemctl daemon-reload
  # Aplica el swappiness ya, sin esperar al reinicio (que hace falta igualmente
  # para que rpi-swap elija el mecanismo).
  run sysctl --system
  echo
  echo "   Hace falta REINICIAR para que rpi-swap aplique el mecanismo:"
  echo "     sudo reboot"
  echo "   Luego comprobar con:  zramctl ; swapon --show ; free -m"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_JARVIS" -eq 1 ]; then
  echo "== 3/6 · servicio Jarvis (puerto 3081) =="
  # ---------------------------------------------------------------
  # ¿Qué binario de dsh se escribe en la unidad?
  # ---------------------------------------------------------------
  # El ORDEN importa, y la penúltima opción es la que evita romper algo que ya
  # funciona. El motivo: quien ejecuta el instalador es root (con sudo), y el
  # PATH de root no incluye instalaciones locales ni la caché de npx. Resolver
  # solo con `command -v dsh` puede dar una ruta INEXISTENTE, y Jarvis arrancaría
  # igual —el health check no usa dsh— para fallar solo al conversar. Silencioso.
  #
  #   1. lo que diga la configuración o el entorno  (explícito manda)
  #   2. una instalación global /usr/local/bin/dsh   (la canónica y estable)
  #   3. el binario de la unidad YA instalada        (lo probado, se conserva)
  #   4. lo que haya en el PATH de quien instala     (último recurso)
  DSH_INSTALADO=""
  if [ -r /etc/systemd/system/jarvis.service ]; then
    DSH_INSTALADO="$(grep -E '^Environment=JARVIS_DSH_BIN=' \
      /etc/systemd/system/jarvis.service 2>/dev/null | tail -1 | cut -d= -f3-)"
  fi

  if [ -n "${JARVIS_DSH_BIN:-}" ] && [ -x "$JARVIS_DSH_BIN" ]; then
    DSH_BIN_PATH="$JARVIS_DSH_BIN"; DSH_ORIGEN="lo dice la configuración"
  elif [ -x /usr/local/bin/dsh ]; then
    DSH_BIN_PATH="/usr/local/bin/dsh"; DSH_ORIGEN="instalación global"
  elif [ -n "$DSH_INSTALADO" ] && [ -x "$DSH_INSTALADO" ]; then
    DSH_BIN_PATH="$DSH_INSTALADO"; DSH_ORIGEN="la unidad que ya estaba, y funciona"
  elif command -v dsh >/dev/null 2>&1; then
    DSH_BIN_PATH="$(command -v dsh)"; DSH_ORIGEN="el PATH de $(id -un), último recurso"
  else
    DSH_BIN_PATH="/usr/local/bin/dsh"; DSH_ORIGEN=""
  fi
  echo "   JARVIS_DSH_BIN=$DSH_BIN_PATH"
  [ -n "$DSH_ORIGEN" ] && echo "   ($DSH_ORIGEN)"

  if [ ! -x "$DSH_BIN_PATH" ]; then
    echo "   ⚠ AVISO: '$DSH_BIN_PATH' NO existe o no es ejecutable." >&2
    echo "     Jarvis arrancará igual, pero el chat y la orquestación fallarán." >&2
    echo "     Instálalo con '--dsh-global' o fija JARVIS_DSH_BIN." >&2
  elif [ -n "$DSH_INSTALADO" ] && [ "$DSH_BIN_PATH" != "$DSH_INSTALADO" ]; then
    echo "   (cambia respecto a la unidad instalada, que usaba $DSH_INSTALADO)"
  fi

  case "$DSH_BIN_PATH" in
    *"/_npx/"*)
      echo "   ⚠ AVISO: esa ruta está en la caché de npx, que puede vaciarse y"
      echo "     cambia al actualizar dsh. Fíjala con '--dsh-global' o apuntando"
      echo "     JARVIS_DSH_BIN a una instalación estable."
      ;;
  esac

  # Se pasa a la plantilla, que es quien lo escribe dentro de la unidad.
  JARVIS_DSH_BIN="$DSH_BIN_PATH"
  instalar_unidad jarvis.service
  run systemctl daemon-reload
  run systemctl enable --now jarvis
  echo "   Estado:  systemctl status jarvis"
  echo "   Log:     journalctl -u jarvis -f"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_BACKUP" -eq 1 ]; then
  echo "== 4/6 · respaldo Git automático cada 30 min =="
  echo "   Comprobando el acceso SSH al remoto..."
  asegurar_known_hosts "jarvis"
  run chmod +x "$REPO_DIR/scripts/backup.sh"
  instalar_unidad jarvis-backup.service
  instalar_unidad jarvis-backup.timer
  run systemctl daemon-reload
  run systemctl enable --now jarvis-backup.timer
  echo "   Próximas ejecuciones:  systemctl list-timers jarvis-backup.timer"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_AUTOUPDATE" -eq 1 ]; then
  echo "== 5/6 · autoactualización con reversión =="
  asegurar_known_hosts "jarvis"

  # Sólo avisa si el servicio no existe NI se está instalando en esta misma
  # ejecución (el paso 3 va antes que este). Si no, el aviso confunde.
  if [ ! -f /etc/systemd/system/jarvis.service ] && [ "$DO_JARVIS" -eq 0 ]; then
    echo "   AVISO: jarvis.service no está instalado."
    echo "   La autoactualización lo necesita para reiniciarlo y comprobar su"
    echo "   salud. Ejecuta antes:  sudo bash deploy/instalar.sh --jarvis"
    echo
  fi

  # El actualizador se COPIA fuera del repositorio: así una actualización no
  # modifica el script que la está ejecutando (bash lo lee mientras lo ejecuta).
  run mkdir -p "$JARVIS_SBIN_DIR"
  run install -m 0755 -o root -g root \
      "$REPO_DIR/scripts/autoactualizar.sh" "$JARVIS_SBIN_DIR/jarvis-actualizar"

  # Y este ayudante es lo que permite que el actualizador se ponga al día SOLO a
  # partir de ahora: la unidad lo ejecuta como root justo antes de lanzarlo, así
  # que ya no hace falta que reinstales el actualizador a mano. Es de root a
  # propósito, para que el agente no pueda reemplazarlo por su cuenta.
  run install -m 0755 -o root -g root \
      "$REPO_DIR/deploy/reinstalar-actualizador.sh" "$JARVIS_SBIN_DIR/jarvis-reinstalar-actualizador"

  instalar_unidad jarvis-autoupdate.service
  instalar_unidad jarvis-autoupdate.path
  instalar_unidad jarvis-autoupdate.timer
  # La bandera del AGENTE, dentro de su workspace: es la que le permite cerrar el
  # circuito él solo, porque el sandbox no lo deja escribir la de fuera.
  instalar_unidad jarvis-solicitud.path

  # La regla de sudoers se valida ANTES de instalarla: un fichero mal formado
  # en /etc/sudoers.d rompe sudo por completo, y en una Pi sin pantalla eso
  # es quedarse fuera del sistema.
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] visudo -cf $REPO_DIR/deploy/sudoers-jarvis-update"
    echo "  [dry-run] install -m 0440 -o root -g root $REPO_DIR/deploy/sudoers-jarvis-update /etc/sudoers.d/jarvis-update"
  else
    if visudo -cf "$REPO_DIR/deploy/sudoers-jarvis-update" >/dev/null 2>&1; then
      install -m 0440 -o root -g root \
        "$REPO_DIR/deploy/sudoers-jarvis-update" /etc/sudoers.d/jarvis-update
      echo "  + regla de sudoers validada e instalada"
    else
      echo "  ERROR: la regla de sudoers no es válida. NO se instala." >&2
      visudo -cf "$REPO_DIR/deploy/sudoers-jarvis-update" >&2 || true
    fi
  fi

  run systemctl daemon-reload
  run systemctl enable --now jarvis-autoupdate.path
  run systemctl enable --now jarvis-autoupdate.timer
  run systemctl enable --now jarvis-solicitud.path
  echo
  echo "   Comprobar:   systemctl status jarvis-autoupdate.path jarvis-solicitud.path"
  echo "   Actualizar:  touch $JARVIS_UPDATE_FLAG"
  echo "   El agente:   touch $JARVIS_CODE_DIR/.solicitar-actualizacion"
  echo "   Sólo mirar:  sudo -u $JARVIS_USER $JARVIS_SBIN_DIR/jarvis-actualizar --check"
  echo "   A mano:      $JARVIS_MANTENIMIENTO ayuda"
  echo
fi

# Los valores ya resueltos quedan también en /etc, para que los encuentren los
# comandos que se ejecutan a mano fuera de systemd.
escribir_conf_sistema

echo "============================================================"
echo " Hecho. Comprobaciones sugeridas:"
echo "   free -m                    # swap usado debe bajar"
echo "   zramctl                    # dispositivo zram0 activo"
echo "   swapon --show              # prioridades de swap"
echo "   systemctl status jarvis"
echo "   curl -s localhost:$JARVIS_PORT/api/health"
echo "============================================================"
