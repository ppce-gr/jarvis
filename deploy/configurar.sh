#!/usr/bin/env bash
# ============================================================
#  Jarvis · asistente de configuración
# ------------------------------------------------------------
#  Deduce los valores de TU máquina, te los propone uno a uno
#  (Enter acepta) y escribe deploy/jarvis.conf.
#
#  No necesita root: la configuración vive en el repositorio y
#  solo la lee quien instala. `instalar.sh` la copia luego a
#  /etc/jarvis/jarvis.conf para que la encuentren los comandos
#  que se ejecutan a mano.
#
#  Uso:
#     ./deploy/configurar.sh            interactivo
#     ./deploy/configurar.sh --yes      acepta todos los valores deducidos
#     ./deploy/configurar.sh --mostrar  sólo enseña lo que deduciría
# ============================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="$REPO_DIR/deploy/jarvis.conf"

SI=0
MOSTRAR=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)  SI=1 ;;
    --mostrar) MOSTRAR=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -t 0 ] && [ "$SI" -eq 0 ] && [ "$MOSTRAR" -eq 0 ]; then
  echo "No hay terminal interactiva. Usa --yes para aceptar los valores deducidos" >&2
  echo "o --mostrar para verlos sin escribir nada." >&2
  exit 1
fi

# ---------------------------------------------------------------
# Valores deducidos
# ---------------------------------------------------------------
# Si ya hay una configuración, se usa como punto de partida: volver a ejecutar
# el asistente no te obliga a reescribirlo todo.
[ -f "$DESTINO" ] && . "$DESTINO"

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  DEF_USUARIO="$SUDO_USER"
else
  DEF_USUARIO="$(id -un)"
fi
DEF_GRUPO="$(id -gn "$DEF_USUARIO" 2>/dev/null || echo "$DEF_USUARIO")"
DEF_HOME="$(getent passwd "$DEF_USUARIO" 2>/dev/null | cut -d: -f6)"
[ -n "$DEF_HOME" ] || DEF_HOME="$HOME"

# La disposición por defecto: el repositorio donde está, y la memoria y el
# estado como hermanos suyos. Es lo que funciona sin configurar nada.
BASE="$(dirname "$REPO_DIR")"
DEF_CODE="$REPO_DIR"
DEF_BRAIN="$BASE/jarvis-vault"
DEF_ESTADO="$BASE/.update-state"
DEF_BANDERA="$BASE/.update-request"
DEF_SBIN="/usr/local/sbin"
DEF_NODE="$(command -v node 2>/dev/null || echo /usr/bin/node)"
DEF_MANT="$DEF_HOME/mantenimiento.sh"
DEF_PUERTO=3081
DEF_SMOKE=3099

preguntar() {   # $1 pregunta · $2 valor por defecto → deja el resultado en PREGUNTA
  local defecto="$2" respuesta=""
  if [ "$SI" -eq 1 ] || [ "$MOSTRAR" -eq 1 ]; then
    PREGUNTA="$defecto"
    # En estos modos no se pregunta, así que hay que enseñar el valor: si no,
    # --mostrar sería una lista de preguntas sin respuestas.
    printf '  %s\n    → %s\n' "$1" "$defecto"
    return 0
  fi
  printf '  %s\n    [%s]: ' "$1" "$defecto"
  read -r respuesta || true
  PREGUNTA="${respuesta:-$defecto}"
}

echo
echo "════ Configuración de Jarvis ════"
if [ "$MOSTRAR" -eq 1 ]; then
  echo " (--mostrar: no se escribe nada)"
elif [ "$SI" -eq 1 ]; then
  echo " (--yes: se aceptan los valores deducidos)"
fi
echo " Pulsa Enter para aceptar el valor propuesto."
echo

echo "── Identidad ──────────────────────────────"
preguntar "Usuario del sistema que ejecuta Jarvis (NO root)" "${JARVIS_USER:-$DEF_USUARIO}"; USUARIO="$PREGUNTA"
preguntar "Grupo" "${JARVIS_GROUP:-$DEF_GRUPO}"; GRUPO="$PREGUNTA"
HOME_USUARIO="$(getent passwd "$USUARIO" 2>/dev/null | cut -d: -f6)"
[ -n "$HOME_USUARIO" ] || HOME_USUARIO="$DEF_HOME"

echo
echo "── Rutas ──────────────────────────────────"
preguntar "Repositorio de CÓDIGO (el público)" "${JARVIS_CODE_DIR:-$DEF_CODE}"; CODE="$PREGUNTA"
preguntar "Repositorio de MEMORIA (el privado, las notas)" "${JARVIS_BRAIN_DIR:-$DEF_BRAIN}"; BRAIN="$PREGUNTA"
preguntar "Estado del actualizador (ancla, registro, post-mortem)" "${JARVIS_UPDATE_STATE:-$DEF_ESTADO}"; ESTADO="$PREGUNTA"
preguntar "Bandera que vigila systemd" "${JARVIS_UPDATE_FLAG:-$DEF_BANDERA}"; BANDERA="$PREGUNTA"

echo
echo "── Red ────────────────────────────────────"
preguntar "Puerto de la interfaz" "${JARVIS_PORT:-$DEF_PUERTO}"; PUERTO="$PREGUNTA"
preguntar "Puerto del arranque de prueba (debe estar libre)" "${JARVIS_SMOKE_PORT:-$DEF_SMOKE}"; SMOKE="$PREGUNTA"

echo
echo "── Instalación ────────────────────────────"
preguntar "Directorio para los binarios del sistema" "${JARVIS_SBIN_DIR:-$DEF_SBIN}"; SBIN="$PREGUNTA"
preguntar "Intérprete de Node" "${JARVIS_NODE_BIN:-$DEF_NODE}"; NODE="$PREGUNTA"
# El binario de dsh NO se pregunta a propósito: el instalador lo resuelve en el
# momento de instalar (entorno > PATH > /usr/local/bin/dsh), y eso es más fiable
# que fijarlo aquí. Si lo preguntáramos, capturaríamos lo que haya ahora —por
# ejemplo una ruta de la caché de npx, que cambia al actualizar— y esa ruta
# tendría prioridad sobre el PATH, dejando `--dsh-global` sin efecto.
preguntar "Copia a mano del script de mantenimiento" "${JARVIS_MANTENIMIENTO:-$DEF_MANT}"; MANT="$PREGUNTA"

# ---------------------------------------------------------------
# Validación: avisar, no impedir
# ---------------------------------------------------------------
echo
echo "── Comprobaciones ─────────────────────────"
AVISOS=0
aviso() { printf '  ⚠ %s\n' "$*"; AVISOS=$((AVISOS + 1)); }
bien()  { printf '  ✓ %s\n' "$*"; }

if id -u "$USUARIO" >/dev/null 2>&1; then
  bien "el usuario «$USUARIO» existe"
else
  aviso "el usuario «$USUARIO» no existe. Créalo antes de instalar: sudo adduser $USUARIO"
fi
if [ "$USUARIO" = "root" ]; then
  aviso "Jarvis no debería correr como root: el servicio no necesita privilegios."
fi

if [ -d "$CODE/.git" ]; then
  bien "el repositorio de código está en $CODE"
else
  aviso "no encuentro un repositorio Git en $CODE"
fi

if [ -d "$BRAIN" ]; then
  bien "la memoria está en $BRAIN"
else
  aviso "no existe la memoria en $BRAIN. Créala o clónala antes de instalar."
fi

if [ -d "$(dirname "$ESTADO")" ]; then
  bien "el estado se guardará en $ESTADO"
else
  aviso "no existe $(dirname "$ESTADO")"
fi

for p in "$PUERTO" "$SMOKE"; do
  if [ "$p" = "$SMOKE" ] && [ "$SMOKE" = "$PUERTO" ]; then
    aviso "los dos puertos son el mismo ($p); el arranque de prueba chocaría"
  elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$p "; then
    aviso "el puerto $p ya está en uso (¿es Jarvis, ya en marcha?)"
  else
    bien "el puerto $p está libre"
  fi
done

[ -x "$NODE" ] || aviso "no encuentro un Node ejecutable en $NODE"
info "el binario de dsh lo resolverá el instalador (entorno > PATH > /usr/local/bin/dsh)"

if [ "$MOSTRAR" -eq 1 ]; then
  echo
  echo "(--mostrar: no se ha escrito nada. Quitaría --mostrar para escribirlo.)"
  exit 0
fi

# ---------------------------------------------------------------
# Escribir la configuración
# ---------------------------------------------------------------
# Todo con ${VAR:-valor} para que una variable de entorno siga teniendo la
# última palabra: así las pruebas y los ajustes puntuales pueden sobrescribir
# sin tocar el fichero.
{
  echo "# ============================================================"
  echo "#  Jarvis · configuración de despliegue"
  echo "#  Generado por deploy/configurar.sh el $(date '+%Y-%m-%d %H:%M')"
  echo "#"
  echo "#  Vuelve a ejecutar el asistente si cambias de rutas, y luego:"
  echo "#      sudo bash deploy/instalar.sh --all"
  echo "# ============================================================"
  echo
  echo "JARVIS_USER=\"\${JARVIS_USER:-$USUARIO}\""
  echo "JARVIS_GROUP=\"\${JARVIS_GROUP:-$GRUPO}\""
  echo "JARVIS_CODE_DIR=\"\${JARVIS_CODE_DIR:-$CODE}\""
  echo "JARVIS_BRAIN_DIR=\"\${JARVIS_BRAIN_DIR:-$BRAIN}\""
  echo "JARVIS_UPDATE_STATE=\"\${JARVIS_UPDATE_STATE:-$ESTADO}\""
  echo "JARVIS_UPDATE_FLAG=\"\${JARVIS_UPDATE_FLAG:-$BANDERA}\""
  echo "JARVIS_PORT=\"\${JARVIS_PORT:-$PUERTO}\""
  echo "JARVIS_SMOKE_PORT=\"\${JARVIS_SMOKE_PORT:-$SMOKE}\""
  echo "JARVIS_SBIN_DIR=\"\${JARVIS_SBIN_DIR:-$SBIN}\""
  echo "JARVIS_NODE_BIN=\"\${JARVIS_NODE_BIN:-$NODE}\""
  echo "JARVIS_MANTENIMIENTO=\"\${JARVIS_MANTENIMIENTO:-$MANT}\""
  echo
  echo "# Valores que casi nunca hace falta cambiar: están documentados, con sus"
  echo "# valores por defecto, en deploy/jarvis.conf.example"
} > "$DESTINO"

echo
echo "════════════════════════════════════════════"
echo " Configuración escrita en:"
echo "   $DESTINO"
[ "$AVISOS" -gt 0 ] && echo " ($AVISOS aviso(s) arriba: revísalos antes de instalar)"
echo
echo " Siguiente paso:"
echo "   sudo bash deploy/instalar.sh --all"
echo
echo " Y para comprobar:"
echo "   systemctl status jarvis"
echo "   curl -s localhost:$PUERTO/api/health"
echo "════════════════════════════════════════════"
