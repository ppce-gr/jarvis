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
DO_LEGACY=0

uso() {
  cat <<'EOF'
Opciones:
  --zram         Activa swap comprimido en RAM (zram) + swappiness.
                 Recomendado: ataca el swap de 493 MB que hoy escribe en la SD.
  --jarvis       Instala y arranca el servicio jarvis.service (puerto 3081).
  --backup       Instala el temporizador de respaldo Git cada 30 minutos.
  --dsh-global   Instala el CLI dsh global con versión fijada (recomendado).
  --legacy       Instala la versión corregida del servicio dsh web temporal.
                 NO lo actives junto a init_deep_deep_seek.service: chocan.
  --all          Equivale a --zram --jarvis --backup --dsh-global
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
    --legacy)     DO_LEGACY=1 ;;
    --all)        DO_ZRAM=1; DO_JARVIS=1; DO_BACKUP=1; DO_DSH_GLOBAL=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    uso; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; uso; exit 1 ;;
  esac
done

if [ "$((DO_ZRAM + DO_JARVIS + DO_BACKUP + DO_DSH_GLOBAL + DO_LEGACY))" -eq 0 ]; then
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
  echo "== 1/5 · CLI dsh global con versión fijada =="
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
  echo "== 2/5 · zram (swap comprimido en RAM) =="
  echo "   Motivo: hoy hay 493 MB de swap en /var/swap, que es la SD."
  run apt-get install -y systemd-zram-generator
  run cp "$REPO_DIR/deploy/zram-generator.conf" /etc/systemd/zram-generator.conf
  run cp "$REPO_DIR/deploy/sysctl-swappiness.conf" /etc/sysctl.d/99-jarvis-memoria.conf
  run systemctl daemon-reload
  run systemctl start systemd-zram-setup@zram0.service
  run sysctl --system
  echo "   Comprueba después con:  zramctl  y  swapon --show"
  echo "   (zram0 debe tener prioridad 100; /var/swap queda de reserva)"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_JARVIS" -eq 1 ]; then
  echo "== 3/5 · servicio Jarvis (puerto 3081) =="
  # La ruta del binario dsh se inyecta en la unidad, para no depender de que
  # coincida con la que viene por defecto en el fichero del repositorio.
  DSH_BIN_PATH="${DSH_BIN_PATH:-$(command -v dsh 2>/dev/null || echo /usr/local/bin/dsh)}"
  echo "   JARVIS_DSH_BIN=$DSH_BIN_PATH"
  case "$DSH_BIN_PATH" in
    *"/_npx/"*)
      echo "   ⚠ AVISO: esa ruta está en la caché de npx, que cambia al actualizar"
      echo "     la versión de dsh. Ejecuta antes '--dsh-global' para fijarla."
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
  echo "== 4/5 · respaldo Git automático cada 30 min =="
  run chmod +x "$REPO_DIR/scripts/backup.sh"
  run cp "$REPO_DIR/deploy/systemd/jarvis-backup.service" /etc/systemd/system/
  run cp "$REPO_DIR/deploy/systemd/jarvis-backup.timer" /etc/systemd/system/
  run systemctl daemon-reload
  run systemctl enable --now jarvis-backup.timer
  echo "   Próximas ejecuciones:  systemctl list-timers jarvis-backup.timer"
  echo
fi

# ------------------------------------------------------------
if [ "$DO_LEGACY" -eq 1 ]; then
  echo "== 5/5 · dsh web corregido (TEMPORAL) =="
  echo "   ATENCIÓN: sustituye a init_deep_deep_seek.service."
  echo "   Se apaga el antiguo para que no choquen por los puertos."
  run cp "$REPO_DIR/deploy/legacy/arrancar-dsh.sh" /home/jarvis/arrancar-dsh.sh
  run chmod +x /home/jarvis/arrancar-dsh.sh
  run cp "$REPO_DIR/deploy/legacy/dsh-web.service" /etc/systemd/system/dsh-web.service
  run systemctl disable --now init_deep_deep_seek.service
  run systemctl daemon-reload
  run systemctl enable --now dsh-web
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
