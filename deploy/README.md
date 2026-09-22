# Despliegue en la Raspberry Pi 3B

Todo lo de esta carpeta son **ficheros de sistema** que instala el usuario con
`sudo`. El agente que preparó el repositorio no puede tocarlos: su entorno monta
el sistema de ficheros en solo lectura fuera del workspace y `sudo` está
desactivado. **Nada de aquí se ha ejecutado todavía.**

El análisis y las mediciones que justifican cada pieza están resumidos en el
propio fichero y en [`docs/arquitectura-jarvis-pi3.md`](../docs/arquitectura-jarvis-pi3.md).

---

## Resumen de lo que hay que arreglar

| # | Problema medido | Gravedad | Solución preparada |
|---|---|---|---|
| 1 | **Cientos de MB de swap escribiéndose en la SD** (`/var/swap` en `/dev/mmcblk0p2`) | 🔴 Alta | `rpi-swap-jarvis.conf` + `sysctl-swappiness.conf` |
| 2 | `npx @deepseek-ai/dsh@latest` en el arranque | 🟠 Media | `npm install -g @deepseek-ai/dsh@0.1.5-rc.2` |
| 3 | Jarvis corre dentro del cgroup del servicio de DSH | 🟡 Baja | `systemd/jarvis.service` propio |

---

## Contenido

```text
deploy/
├── README.md                      # este fichero
├── instalar.sh                    # aplica los cambios (idempotente, con --dry-run)
├── rpi-swap-jarvis.conf          → /etc/rpi/swap.conf.d/99-jarvis.conf
├── sysctl-swappiness.conf        → /etc/sysctl.d/99-jarvis-memoria.conf
├── systemd/
│   ├── jarvis.service            → /etc/systemd/system/  (interfaz, puerto 3081)
│   ├── jarvis-backup.service     → /etc/systemd/system/
│   └── jarvis-backup.timer       → /etc/systemd/system/  (cada 30 min)
```

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

---

## El montaje antiguo de `dsh web`

Se ha retirado de este repositorio: era específico de una máquina concreta y hoy
es historia. El chat vive dentro de Jarvis, así que ni `dsh web` ni su `socat` ni
el redirector de Python hacen falta.

El registro de aquel montaje —con sus dos fallos: el `killall` indiscriminado y
el `npx @latest`— vive en el repositorio privado, en
`sistema-jarvis/legacy-dsh-web/`.
