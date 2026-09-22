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
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.2}"

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

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    echo "  + $*"
    "$@"
  fi
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
  run npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"
  DSH_BIN_PATH="$(command -v dsh 2>/dev/null || echo "$(npm config get prefix 2>/dev/null || echo /usr/local)/bin/dsh")"
  echo "   Binario: $DSH_BIN_PATH"
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
  # La ruta del binario dsh se inyecta en la unidad, para no depender de que
  # coincida con la que viene por defecto en el fichero del repositorio.
  # Prioridad: lo que diga el entorno > lo que haya en el PATH > lo instalado.
  # Así se puede apuntar a una instalación local sin root (por ejemplo
  # /home/jarvis/jarvis/.tools/bin/dsh) sin tener que tocar el PATH del sistema.
  DSH_BIN_PATH="${JARVIS_DSH_BIN:-${DSH_BIN_PATH:-$(command -v dsh 2>/dev/null || echo /usr/local/bin/dsh)}}"
  echo "   JARVIS_DSH_BIN=$DSH_BIN_PATH"
  case "$DSH_BIN_PATH" in
    *"/_npx/"*)
      echo "   ⚠ AVISO: esa ruta está en la caché de npx, que puede vaciarse y"
      echo "     cambia al actualizar dsh. Fíjala con '--dsh-global' o apuntando"
      echo "     JARVIS_DSH_BIN a una instalación estable."
      ;;
    *)
      if [ ! -x "$DSH_BIN_PATH" ]; then
        echo "   ⚠ AVISO: '$DSH_BIN_PATH' no existe o no es ejecutable."
      fi
      ;;
  esac
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] sed 's|^Environment=JARVIS_DSH_BIN=.*|Environment=JARVIS_DSH_BIN=$DSH_BIN_PATH|' \\"
    echo "            $REPO_DIR/deploy/systemd/jarvis.service > /etc/systemd/system/jarvis.service"
  else
    sed "s|^Environment=JARVIS_DSH_BIN=.*|Environment=JARVIS_DSH_BIN=$DSH_BIN_PATH|" \
      "$REPO_DIR/deploy/systemd/jarvis.service" > /etc/systemd/system/jarvis.service
    echo "  + unidad escrita en /etc/systemd/system/jarvis.service"
  fi
  run systemctl daemon-reload
  run systemctl enable --now jarvis
  echo "   Estado:  systemctl status jarvis"
  echo "   Log:     journalctl -u jarvis -f"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_BACKUP" -eq 1 ]; then
  echo "== 4/6 · respaldo Git automático cada 30 min =="
  run chmod +x "$REPO_DIR/scripts/backup.sh"
  run cp "$REPO_DIR/deploy/systemd/jarvis-backup.service" /etc/systemd/system/
  run cp "$REPO_DIR/deploy/systemd/jarvis-backup.timer" /etc/systemd/system/
  run systemctl daemon-reload
  run systemctl enable --now jarvis-backup.timer
  echo "   Próximas ejecuciones:  systemctl list-timers jarvis-backup.timer"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_AUTOUPDATE" -eq 1 ]; then
  echo "== 5/6 · autoactualización con reversión =="

  if [ ! -f /etc/systemd/system/jarvis.service ]; then
    echo "   AVISO: jarvis.service no está instalado."
    echo "   La autoactualización lo necesita para reiniciarlo y comprobar su"
    echo "   salud. Ejecuta antes:  sudo bash deploy/instalar.sh --jarvis"
    echo
  fi

  # El actualizador se COPIA fuera del repositorio: así una actualización no
  # modifica el script que la está ejecutando (bash lo lee mientras lo ejecuta).
  run install -m 0755 -o root -g root \
      "$REPO_DIR/scripts/autoactualizar.sh" /usr/local/sbin/jarvis-actualizar

  run cp "$REPO_DIR/deploy/systemd/jarvis-autoupdate.service" /etc/systemd/system/
  run cp "$REPO_DIR/deploy/systemd/jarvis-autoupdate.path" /etc/systemd/system/
  run cp "$REPO_DIR/deploy/systemd/jarvis-autoupdate.timer" /etc/systemd/system/

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
  echo
  echo "   Comprobar:   systemctl status jarvis-autoupdate.path"
  echo "   Actualizar:  touch /home/jarvis/jarvis/.update-request"
  echo "   Sólo mirar:  sudo -u jarvis /usr/local/sbin/jarvis-actualizar --check"
  echo
fi

echo "============================================================"
echo " Hecho. Comprobaciones sugeridas:"
echo "   free -m                    # swap usado debe bajar"
echo "   zramctl                    # dispositivo zram0 activo"
echo "   swapon --show              # prioridades de swap"
echo "   systemctl status jarvis"
echo "   curl -s localhost:3081/api/health"
echo "============================================================"
