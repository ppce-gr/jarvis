#!/usr/bin/env bash
# ============================================================
#  Jarvis · instalar el DSH web (acceso al agente desde el móvil)
# ------------------------------------------------------------
#  Instala:
#    /usr/local/lib/jarvis/dsh-web/arrancar-dsh.sh   el arranque saneado
#    /usr/local/lib/jarvis/dsh-web/redireccionar.py  el redirector fijo
#    /etc/systemd/system/jarvis-dsh-web.service      la unidad
#
#  Y RETIRA el arranque antiguo `init_deep_deep_seek.service`, cuyo script
#  empezaba con `killall -9 node` y mataba a `jarvis.service` (mismo usuario)
#  en cada arranque.
#
#  Uso:
#      sudo bash deploy/instalar-dsh-web.sh
#      sudo bash deploy/instalar-dsh-web.sh --quitar    (vuelve al estado previo)
#
#  Es SEPARADO de `deploy/instalar.sh` por el mismo motivo que
#  `instalar-permisos.sh`: toca systemd y quiero que sea una decisión
#  explícita, no un efecto secundario de reinstalar Jarvis.
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for conf in "$REPO_DIR/deploy/jarvis.conf" /etc/jarvis/jarvis.conf; do
  [ -f "$conf" ] && . "$conf"
done

JARVIS_USER="${JARVIS_USER:-jarvis}"
JARVIS_GROUP="${JARVIS_GROUP:-$JARVIS_USER}"
JARVIS_CODE_DIR="${JARVIS_CODE_DIR:-$REPO_DIR}"
JARVIS_HOME="${JARVIS_HOME:-$(getent passwd "$JARVIS_USER" 2>/dev/null | cut -d: -f6)}"
JARVIS_HOME="${JARVIS_HOME:-/home/$JARVIS_USER}"

JARVIS_DSH_WEB_DIR="${JARVIS_DSH_WEB_DIR:-/usr/local/lib/jarvis/dsh-web}"
JARVIS_DSH_WEB_HOST="${JARVIS_DSH_WEB_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
JARVIS_DSH_WEB_VERSION="${JARVIS_DSH_WEB_VERSION:-0.2.0-rc.2}"
JARVIS_DSH_WEB_MAX_OLD_SPACE="${JARVIS_DSH_WEB_MAX_OLD_SPACE:-384}"
JARVIS_DSH_WEB_PORT="${JARVIS_DSH_WEB_PORT:-3080}"
JARVIS_DSH_WEB_PROXY_PORT="${JARVIS_DSH_WEB_PROXY_PORT:-3085}"
JARVIS_DSH_WEB_PUBLIC_PORT="${JARVIS_DSH_WEB_PUBLIC_PORT:-8080}"

ORIGEN_UNIDAD="$REPO_DIR/deploy/systemd/jarvis-dsh-web.service.in"
DESTINO_UNIDAD="/etc/systemd/system/jarvis-dsh-web.service"
UNIDAD="jarvis-dsh-web.service"
UNIDAD_VIEJA="init_deep_deep_seek.service"
ARRANQUE_HOME="$JARVIS_HOME/arrancar-dsh.sh"
COPIA_HOME="$ARRANQUE_HOME.antes-jarvis-dsh-web"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: hay que lanzarlo con sudo." >&2
  exit 1
fi

# --- Desinstalar -------------------------------------------------------------
if [ "${1:-}" = "--quitar" ]; then
  systemctl disable --now "$UNIDAD" 2>/dev/null || true
  rm -f "$DESTINO_UNIDAD"
  rm -rf "$JARVIS_DSH_WEB_DIR"
  if [ -f "$COPIA_HOME" ]; then
    mv -f "$COPIA_HOME" "$ARRANQUE_HOME"
    echo "+ restaurado el arranque antiguo en $ARRANQUE_HOME"
  fi
  if [ -f "/etc/systemd/system/$UNIDAD_VIEJA" ]; then
    systemctl enable --now "$UNIDAD_VIEJA" 2>/dev/null || true
    echo "+ reactivado $UNIDAD_VIEJA"
  fi
  systemctl daemon-reload
  echo "+ desinstalado"
  exit 0
fi

# --- 1) Validar el script ANTES de instalarlo --------------------------------
if ! bash -n "$REPO_DIR/deploy/dsh-web/arrancar-dsh.sh"; then
  echo "ERROR: el script de arranque tiene un error de sintaxis. NO se instala nada." >&2
  exit 1
fi
if ! python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$REPO_DIR/deploy/dsh-web/redireccionar.py" 2>/dev/null; then
  echo "ERROR: el redirector tiene un error de sintaxis. NO se instala nada." >&2
  exit 1
fi

# --- 2) Scripts --------------------------------------------------------------
install -d -m 0755 -o root -g root "$JARVIS_DSH_WEB_DIR"
install -m 0755 -o root -g root "$REPO_DIR/deploy/dsh-web/arrancar-dsh.sh" "$JARVIS_DSH_WEB_DIR/arrancar-dsh.sh"
install -m 0644 -o root -g root "$REPO_DIR/deploy/dsh-web/redireccionar.py" "$JARVIS_DSH_WEB_DIR/redireccionar.py"
echo "+ scripts instalados en $JARVIS_DSH_WEB_DIR"

# --- 3) Unidad (plantilla → fichero) ----------------------------------------
render() {
  sed -e "s|@JARVIS_USER@|$JARVIS_USER|g" \
      -e "s|@JARVIS_GROUP@|$JARVIS_GROUP|g" \
      -e "s|@JARVIS_HOME@|$JARVIS_HOME|g" \
      -e "s|@JARVIS_CODE_DIR@|$JARVIS_CODE_DIR|g" \
      -e "s|@JARVIS_DSH_WEB_DIR@|$JARVIS_DSH_WEB_DIR|g" \
      -e "s|@JARVIS_DSH_WEB_HOST@|$JARVIS_DSH_WEB_HOST|g" \
      -e "s|@JARVIS_DSH_WEB_VERSION@|$JARVIS_DSH_WEB_VERSION|g" \
      -e "s|@JARVIS_DSH_WEB_MAX_OLD_SPACE@|$JARVIS_DSH_WEB_MAX_OLD_SPACE|g" \
      -e "s|@JARVIS_DSH_WEB_PORT@|$JARVIS_DSH_WEB_PORT|g" \
      -e "s|@JARVIS_DSH_WEB_PROXY_PORT@|$JARVIS_DSH_WEB_PROXY_PORT|g" \
      -e "s|@JARVIS_DSH_WEB_PUBLIC_PORT@|$JARVIS_DSH_WEB_PUBLIC_PORT|g" \
      "$ORIGEN_UNIDAD"
}

TMP_UNIDAD="$(mktemp)"
render > "$TMP_UNIDAD"
if grep -q '@[A-Z_]*@' "$TMP_UNIDAD"; then
  echo "ERROR: quedaron marcadores sin resolver en la unidad:" >&2
  grep -n '@[A-Z_]*@' "$TMP_UNIDAD" >&2
  rm -f "$TMP_UNIDAD"
  exit 1
fi
install -m 0644 -o root -g root "$TMP_UNIDAD" "$DESTINO_UNIDAD"
rm -f "$TMP_UNIDAD"
echo "+ unidad instalada en $DESTINO_UNIDAD"

# --- 4) Retirar el arranque antiguo -----------------------------------------
# Su script mataba a jarvis.service con `killall -9 node`. Se desactiva y se
# deja una copia de seguridad del script, pero no se borra nada de la unidad
# antigua: `--quitar` puede devolverla.
if systemctl list-unit-files "$UNIDAD_VIEJA" >/dev/null 2>&1 \
   && [ -n "$(systemctl list-unit-files "$UNIDAD_VIEJA" 2>/dev/null | grep -c "$UNIDAD_VIEJA")" ]; then
  systemctl disable --now "$UNIDAD_VIEJA" 2>/dev/null || true
  echo "+ $UNIDAD_VIEJA detenido y desactivado"
fi

if [ -f "$ARRANQUE_HOME" ] && [ ! -f "$COPIA_HOME" ]; then
  cp -a "$ARRANQUE_HOME" "$COPIA_HOME"
  cat > "$ARRANQUE_HOME" <<EOF
#!/usr/bin/env bash
# Reemplazado por deploy/instalar-dsh-web.sh.
# Este arranque ya no vive aquí: es una redirección al script versionado.
# El original queda en $COPIA_HOME, y 'instalar-dsh-web.sh --quitar' lo restaura.
exec $JARVIS_DSH_WEB_DIR/arrancar-dsh.sh "\$@"
EOF
  chmod 0755 "$ARRANQUE_HOME"
  echo "+ $ARRANQUE_HOME ahora redirige al script versionado (copia en $COPIA_HOME)"
fi

# --- 5) Arrancar -------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now "$UNIDAD"
echo "+ $UNIDAD activado"

echo
echo "Comprobación:   systemctl status $UNIDAD --no-pager"
echo "Enlace fijo:    http://$JARVIS_DSH_WEB_HOST:$JARVIS_DSH_WEB_PUBLIC_PORT"
echo "Configuración:  $JARVIS_DSH_WEB_DIR/arrancar-dsh.sh comprobar"
