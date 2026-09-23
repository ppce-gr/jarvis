#!/usr/bin/env bash
# ============================================================
#  Jarvis · reinstalar el actualizador desde el repositorio
# ------------------------------------------------------------
#  Lo ejecuta systemd como ROOT (ExecStartPre con el prefijo '+')
#  justo antes de lanzar el actualizador. Existe porque
#  /usr/local/sbin es de root y el actualizador, que corre como
#  jarvis, no puede reescribirse a sí mismo.
#
#  Corre ANTES de que bash abra el script, así que no hay
#  automodificación posible: cuando bash lo abra, ya es el nuevo.
#
#  NUNCA bloquea. Si la copia del repositorio no está o no
#  compila, avisa y se queda la instalada, que funciona: es
#  mejor seguir actualizándose con una versión antigua del
#  actualizador que quedarse sin actualizaciones.
#
#  Este fichero se instala en /usr/local/sbin y es de root, así
#  que el agente NO puede cambiarlo: solo cambia cuando tú
#  ejecutas `deploy/instalar.sh --autoupdate`.
# ============================================================
set -uo pipefail

# La configuración del sistema es la que dice dónde está el repositorio: este
# script corre desde el directorio de binarios, así que no puede deducirlo de su
# propia ubicación.
[ -f /etc/jarvis/jarvis.conf ] && . /etc/jarvis/jarvis.conf

ORIGEN="${JARVIS_UPDATER_SOURCE:-${JARVIS_CODE_DIR:+$JARVIS_CODE_DIR/scripts/autoactualizar.sh}}"
DESTINO="${JARVIS_UPDATER_INSTALLED:-${JARVIS_SBIN_DIR:-/usr/local/sbin}/jarvis-actualizar}"

if [ -z "$ORIGEN" ]; then
  echo "AVISO: no sé dónde está el repositorio (falta /etc/jarvis/jarvis.conf y" >&2
  echo "       JARVIS_CODE_DIR). Se sigue con el actualizador instalado." >&2
  exit 0
fi

if [ ! -f "$ORIGEN" ]; then
  echo "AVISO: no encuentro $ORIGEN; se sigue con el actualizador instalado." >&2
  exit 0
fi

# Guarda de sintaxis: un script roto no se instala. Sin esto, un error de
# escritura en el repositorio dejaría el actualizador instalado inservible.
if ! bash -n "$ORIGEN" 2>/dev/null; then
  echo "AVISO: $ORIGEN tiene la sintaxis rota; NO se instala. Se sigue con el instalado." >&2
  exit 0
fi

# Si ya son idénticos no se toca nada: así el caso normal no escribe en disco.
if [ -f "$DESTINO" ] && cmp -s "$ORIGEN" "$DESTINO"; then
  exit 0
fi

if [ "$(id -u)" -eq 0 ]; then
  INSTALAR=(install -m 0755 -o root -g root)
else
  INSTALAR=(install -m 0755)
fi

# Temporal + rename: el reemplazo es atómico y nadie puede leer un fichero a
# medias. Aquí ya no hay nada ejecutándolo, pero es la forma correcta.
TEMP="$(dirname "$DESTINO")/.jarvis-actualizar.nuevo.$$"
if "${INSTALAR[@]}" "$ORIGEN" "$TEMP" 2>/dev/null; then
  mv -f "$TEMP" "$DESTINO"
  echo "actualizador reinstalado desde el repositorio ($(wc -l < "$DESTINO") líneas)"
else
  rm -f "$TEMP"
  echo "AVISO: no pude escribir en $(dirname "$DESTINO"); se sigue con el instalado." >&2
fi
exit 0
