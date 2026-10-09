#!/usr/bin/env bash
# ============================================================
#  Jarvis · instalar el sistema de permisos (root)
# ------------------------------------------------------------
#  Instala:
#    /usr/local/sbin/jarvis-permiso     el ejecutor (root:root 0755)
#    /etc/sudoers.d/jarvis-permisos     la regla (0440, validada con visudo)
#    /etc/jarvis/permisos.hash          el PIN, hasheado (0600)
#
#  Uso:
#      sudo bash deploy/instalar-permisos.sh            (pide el PIN)
#      sudo bash deploy/instalar-permisos.sh --quitar   (lo desinstala)
#
#  Es deliberadamente SEPARADO de `deploy/instalar.sh`: toca root y quiero que
#  sea una decisión explícita, no un efecto secundario de reinstalar Jarvis.
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO_DIR/deploy/jarvis.conf"
[ -f "$CONF" ] && . "$CONF"

JARVIS_USER="${JARVIS_USER:-jarvis}"
JARVIS_BRAIN_DIR="${JARVIS_BRAIN_DIR:-/home/jarvis/jarvis/jarvis-vault}"
JARVIS_NODE_BIN="${JARVIS_NODE_BIN:-/usr/bin/node}"
HELPER_SRC="$REPO_DIR/deploy/permisos/jarvis-permiso"
SUDOERS_SRC="$REPO_DIR/deploy/permisos/sudoers-jarvis-permisos"
HELPER_DST="/usr/local/sbin/jarvis-permiso"
SUDOERS_DST="/etc/sudoers.d/jarvis-permisos"
ESTADO_DIR="/etc/jarvis"
HASH_FILE="$ESTADO_DIR/permisos.hash"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: hay que lanzarlo con sudo." >&2
  exit 1
fi

if [ "${1:-}" = "--quitar" ]; then
  rm -f "$SUDOERS_DST" "$HELPER_DST" "$HASH_FILE"
  echo "+ desinstalado (el historial y las peticiones no se tocan)"
  exit 0
fi

# 1) Helper
sed -e "s|@JARVIS_BRAIN_DIR@|$JARVIS_BRAIN_DIR|g" \
    -e "s|@JARVIS_NODE_BIN@|$JARVIS_NODE_BIN|g" \
    "$HELPER_SRC" > "$HELPER_DST"
chmod 0755 "$HELPER_DST"
chown root:root "$HELPER_DST"
echo "+ helper instalado en $HELPER_DST"

# 2) Regla de sudoers (validada ANTES de instalarla)
if visudo -cf "$SUDOERS_SRC" >/dev/null 2>&1; then
  install -m 0440 -o root -g root "$SUDOERS_SRC" "$SUDOERS_DST"
  echo "+ regla de sudoers validada e instalada"
else
  echo "ERROR: la regla de sudoers no es válida; NO se instala." >&2
  visudo -cf "$SUDOERS_SRC" >&2 || true
  exit 1
fi

# 3) PIN (hasheado, solo root)
instalar_pin() {
  local pin1 pin2 salt hash
  read -r -s -p "PIN para aprobar acciones de root: " pin1; echo
  read -r -s -p "Repite el PIN: " pin2; echo
  if [ -z "$pin1" ] || [ "$pin1" != "$pin2" ]; then
    echo "ERROR: los PIN no coinciden o están vacíos." >&2
    exit 1
  fi
  salt="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  hash="$(printf '%s%s' "$salt" "$pin1" | sha256sum | cut -d' ' -f1)"
  mkdir -p "$ESTADO_DIR"
  printf '%s$%s\n' "$salt" "$hash" > "$HASH_FILE"
  chmod 0600 "$HASH_FILE"
  chown root:root "$HASH_FILE"
  echo "+ PIN guardado (hasheado) en $HASH_FILE"
}

if [ -f "$HASH_FILE" ] && [ "${JARVIS_PERMISOS_CAMBIAR_PIN:-0}" != "1" ]; then
  echo "  (ya había PIN; para cambiarlo: sudo JARVIS_PERMISOS_CAMBIAR_PIN=1 bash deploy/instalar-permisos.sh)"
else
  instalar_pin
fi

echo
echo "Listo. Comprobación:   sudo -n $HELPER_DST estado"
echo "El usuario $JARVIS_USER puede pedir permisos desde la interfaz; tú los apruebas 1 a 1 con el PIN."
