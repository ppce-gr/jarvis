# Despliegue en la Raspberry Pi 3B

Todo lo de esta carpeta son **ficheros de sistema** que instala el usuario con
`sudo`: el agente que preparó el repositorio no puede tocarlos, porque su entorno
monta el sistema de ficheros en solo lectura fuera de su espacio de trabajo y no
tiene `sudo`.

`instalar.sh` es **idempotente** y acepta `--dry-run`, así que puedes ver qué
haría antes de que haga nada.

El análisis y las mediciones que justifican cada pieza están resumidos en el
propio fichero y en [`docs/arquitectura-jarvis-pi3.md`](../docs/arquitectura-jarvis-pi3.md).

---

## Resumen de lo que hay que arreglar

| # | Problema medido | Gravedad | Solución preparada |
|---|---|---|---|
| 1 | **Cientos de MB de swap escribiéndose en la SD** (`/var/swap` en `/dev/mmcblk0p2`) | 🔴 Alta | `rpi-swap-jarvis.conf` + `sysctl-swappiness.conf` |
| 2 | `npx @deepseek-ai/dsh@latest` en el arranque | 🟠 Media | `npm install -g @deepseek-ai/dsh@0.1.5-rc.3` |
| 3 | Jarvis corre dentro del cgroup del servicio de DSH | 🟡 Baja | `systemd/jarvis.service` propio |

---

## Contenido

```text
deploy/
├── README.md                        # este fichero
├── instalar.sh                      # aplica los cambios (idempotente, con --dry-run)
├── mantenimiento.sh                 # las órdenes de root a mano (ver abajo)
├── reinstalar-actualizador.sh      → /usr/local/sbin/jarvis-reinstalar-actualizador
├── rpi-swap-jarvis.conf            → /etc/rpi/swap.conf.d/99-jarvis.conf
├── sysctl-swappiness.conf          → /etc/sysctl.d/99-jarvis-memoria.conf
├── sudoers-jarvis-update           → /etc/sudoers.d/jarvis-update (0440, validado antes con visudo)
└── systemd/
    ├── jarvis.service              → /etc/systemd/system/   (interfaz, puerto 3081)
    ├── jarvis-backup.service       → /etc/systemd/system/
    ├── jarvis-backup.timer         → /etc/systemd/system/   (cada 30 min)
    ├── jarvis-autoupdate.service   → /etc/systemd/system/   (ejecuta el actualizador)
    ├── jarvis-autoupdate.path      → /etc/systemd/system/   (vigila .update-request)
    └── jarvis-autoupdate.timer     → /etc/systemd/system/   (cada día a las 04:30)
```

Los dos scripts que forman el actualizador en sí viven en `scripts/`:
`autoactualizar.sh` (las cinco barreras) y `backup.sh` (el respaldo de los dos
repositorios).

---

## Paso 0 · Ver el plan sin tocar nada

```bash
cd /home/jarvis/jarvis/jarvis
sudo bash deploy/instalar.sh --dry-run --all
```

## Paso 1 · La SD (lo más urgente)

```bash
sudo bash deploy/instalar.sh --zram
sudo reboot
```

### ⚠️ Lo que NO hay que hacer (y por qué está escrito aquí)

El primer intento copió un `/etc/systemd/zram-generator.conf` propio. **Eso
rompe el sistema.** Raspberry Pi OS ya trae:

```text
/usr/lib/systemd/zram-generator.conf                        [zram0] base
/usr/lib/systemd/zram-generator.conf.d/
    20-rpi-swap-zram0-ctrl.conf                             fs-type=none
                                                            host-memory-limit=0
```

Es decir: **el fabricante desactiva zram a propósito** y es `rpi-swap` quien lo
activa cuando el mecanismo lo pide. Un fichero en `/etc/` tiene más precedencia,
así que el nuestro sustituyó ese control y dejó la cadena de dependencias rota
(`systemd-zram-setup@zram0.service` → *dependency failed*).

**La forma correcta es configurar `rpi-swap`**, el gestor nativo, con un drop-in
en `/etc/rpi/swap.conf.d/`. Eso es lo que hace `instalar.sh --zram` ahora, y
además retira el fichero conflictivo si lo encuentra.

Y comprobar que ha funcionado:

```bash
zramctl                 # debe aparecer zram0 con ~900 MB descomprimidos
swapon --show           # debe aparecer zram0... y NO /var/swap
free -m                 # el swap total pasa a ser solo zram
cat /proc/sys/vm/swappiness   # 100
```

Con `Mechanism=zram` **el fichero `/var/swap` deja de usarse**. Cuando lo
confirmes, puedes borrarlo para recuperar 2 GB de SD:

```bash
ls -la /var/swap            # comprueba que sigue ahí (2 GB)
sudo rm -f /var/swap        # solo si NO aparece en swapon --show
```

**Por qué esto importa:** con `swappiness=60` y sin zram, el kernel estaba
mandando memoria a un fichero de la SD. Con zram, el intercambio se comprime en
RAM y la SD sólo se usa si zram se llena. Menos desgaste y mucho más rápido.

**Opcional (si quieres quitar el swap de SD del todo):** edita
`/etc/dphys-swapfile` y pon `CONF_SWAPSIZE=0`, y luego desactívalo:

```bash
sudo dphys-swapfile swapoff
sudo dphys-swapfile uninstall
```

Hazlo **después** de confirmar que zram funciona, nunca antes: sin swap y sin
zram te quedarías sin red de seguridad de memoria.

## Paso 2 · El CLI de DSH, fijado

```bash
sudo bash deploy/instalar.sh --dsh-global
command -v dsh            # → /usr/local/bin/dsh
```

A partir de aquí, `jarvis.service` ya sabe dónde encontrar el motor de agentes
(`JARVIS_DSH_BIN=/usr/local/bin/dsh`). Cuando quieras actualizar, hazlo a
propósito: `npm install -g @deepseek-ai/dsh@latest`.

## Paso 3 · El servicio de Jarvis

```bash
sudo bash deploy/instalar.sh --jarvis
systemctl status jarvis
curl -s localhost:3081/api/health      # {"status":"ok",...}
```

> **Antes de activarlo, apaga el Jarvis que arrancó el agente**, si sigue vivo:
> `pkill -f "node src/index.js"`. Si no, chocarán por el puerto 3081.

## Paso 4 · Respaldo automático

```bash
sudo bash deploy/instalar.sh --backup
systemctl list-timers jarvis-backup.timer
```

Política de commits, que conviene tener clara:

| Repositorio | Qué hace el temporizador |
|---|---|
| **memoria** (privada) | `commit` + `push`. Son notas irremplazables y da igual que la historia tenga ruido. |
| **código** (público) | Sólo `push`. No crea commits: la historia la lee gente, y un `autosave` cada media hora con el trabajo a medias de un agente la ensucia y puede dejar `main` sin pasar las pruebas. |

Con el árbol limpio no se crea ningún commit. Si hay trabajo sin commitear en el
código, el respaldo **avisa** de que no lo está cubriendo, en vez de dar por
respaldado algo que no lo está. Para que también autosalve el código:

```bash
JARVIS_BACKUP_COMMIT_CODE=1 bash scripts/backup.sh
```

Y `mantenimiento.sh respaldo` sí commitea el código: pedir un respaldo a mano es
exactamente decir «guarda lo que tengo ahora».

---

## Paso 5 · Autoactualización

```bash
sudo bash deploy/instalar.sh --autoupdate
```

Esto es lo que permite que Jarvis **se actualice sola y se recupere si algo
falla**:

| Pieza | Para qué |
|---|---|
| `jarvis-autoupdate.path` | Vigila `.update-request`. Escribir ese fichero **no necesita privilegios**. |
| `jarvis-autoupdate.service` | Ejecuta el actualizador **fuera** del árbol de procesos de Jarvis, para sobrevivir a su reinicio. |
| `jarvis-autoupdate.timer` | Comprobación diaria (04:30 + retardo aleatorio). |
| `jarvis-reinstalar-actualizador` | Refresca el actualizador desde el repositorio antes de cada ejecución. |
| `/etc/sudoers.d/jarvis-update` | Permite **sólo** `systemctl restart jarvis.service`. Nada más. |

### Cómo pedir una actualización

```bash
touch /home/jarvis/jarvis/.update-request      # la bandera, y ya está
```

…o el botón del panel. **Ninguna de las dos necesita `sudo`.**

### Las cinco barreras, en orden de coste

| # | Qué comprueba |
|---|---|
| 1 | **Árbol limpio.** Con cambios sin commitear, aborta sin tocar nada. |
| 2 | **Respaldo** de los dos repositorios. Sin respaldo no se actualiza. |
| 3 | **`git merge --ff-only`.** O avanza, o se niega: nunca fusiona ni sobrescribe commits locales. |
| 4 | **`npm test` y un arranque real** en el puerto 3099, *antes* de tocar el servicio. |
| 5 | **Reinicio verificado:** `/api/health` **y** `/api/projects`. Si no responde, revierte al último commit bueno. |

### El script de mantenimiento

`deploy/mantenimiento.sh` reúne las operaciones en un solo sitio. Las que
necesitan root se reejecutan con `sudo` por su cuenta, así que puedes invocarlo
siempre igual:

```bash
./deploy/mantenimiento.sh estado        # versiones, servicio y desfases
./deploy/mantenimiento.sh actualizador  # reinstala unidades y ayudante
./deploy/mantenimiento.sh servicio      # reinstala y arranca jarvis.service
./deploy/mantenimiento.sh parar         # para el servicio
./deploy/mantenimiento.sh arrancar      # lo arranca
./deploy/mantenimiento.sh reiniciar     # lo reinicia, sin actualizar nada
./deploy/mantenimiento.sh actualizar    # dispara la actualización y espera
./deploy/mantenimiento.sh revertir      # vuelve al último commit bueno
./deploy/mantenimiento.sh respaldo      # respalda ahora los dos repositorios
./deploy/mantenimiento.sh fallo         # post-mortem del último fallo
./deploy/mantenimiento.sh registro      # últimas líneas del registro
./deploy/mantenimiento.sh todo          # instalación completa (--all)
```

Para tenerlo siempre a mano, **sin `sudo`**:

```bash
./deploy/mantenimiento.sh instalar      # lo copia a ~/mantenimiento.sh
```

Es una copia: si cambia el del repositorio, vuelve a ejecutar esa orden.

### Cuando algo falla

El actualizador deja un **post-mortem** en `.update-state/ultimo-fallo.txt`: el
commit que se intentaba, la fase que falló, a cuál se volvió, si el servicio
quedó vivo y un extracto del error. Se borra en cuanto una actualización sale
bien, así que **si el fichero está, hay algo pendiente de mirar**. Se ve en el
panel, en `GET /api/system/status` (campo `ultimoFallo`) y con
`mantenimiento.sh fallo`.

El diseño completo, los riesgos y el porqué de cada decisión están en
[`docs/autoactualizacion.md`](../docs/autoactualizacion.md).

---

## El montaje antiguo de `dsh web`

Se ha retirado de este repositorio: era específico de una máquina concreta y hoy
es historia. El chat vive dentro de Jarvis, así que ni `dsh web` ni su `socat` ni
el redirector de Python hacen falta.

El registro de aquel montaje —con sus dos fallos: el `killall` indiscriminado y
el `npx @latest`— vive en el repositorio privado, en
`sistema-jarvis/legacy-dsh-web/`.
