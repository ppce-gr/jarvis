# Despliegue en la Raspberry Pi 3B

Todo lo de esta carpeta son **ficheros de sistema** que instala el usuario con
`sudo`. El agente que preparó el repositorio no puede tocarlos: su entorno monta
el sistema de ficheros en solo lectura fuera del workspace y `sudo` está
desactivado. **Nada de aquí se ha ejecutado todavía.**

El análisis y las mediciones que justifican cada pieza están en el proyecto
`projects/sistema-jarvis/` (nota `despliegue-raspberry.md`).

---

## Resumen de lo que hay que arreglar

| # | Problema medido | Gravedad | Solución preparada |
|---|---|---|---|
| 1 | **493 MB de swap escribiéndose en la SD** (`/var/swap` en `/dev/mmcblk0p2`) | 🔴 Alta | `zram-generator.conf` + `sysctl-swappiness.conf` |
| 2 | `npx @deepseek-ai/dsh@latest` en el arranque | 🟠 Media | `npm install -g @deepseek-ai/dsh@0.1.5-rc.2` |
| 3 | `killall -9 node socat python3` mata también a Jarvis | 🟠 Media | `legacy/arrancar-dsh.sh` corregido |
| 4 | Jarvis corre dentro del cgroup del servicio de DSH | 🟡 Baja | `systemd/jarvis.service` propio |

---

## Contenido

```text
deploy/
├── README.md                      # este fichero
├── instalar.sh                    # aplica los cambios (idempotente, con --dry-run)
├── zram-generator.conf           → /etc/systemd/zram-generator.conf
├── sysctl-swappiness.conf        → /etc/sysctl.d/99-jarvis-memoria.conf
├── systemd/
│   ├── jarvis.service            → /etc/systemd/system/  (interfaz, puerto 3081)
│   ├── jarvis-backup.service     → /etc/systemd/system/
│   └── jarvis-backup.timer       → /etc/systemd/system/  (cada 30 min)
└── legacy/
    ├── dsh-web.service           → /etc/systemd/system/  (TEMPORAL)
    └── arrancar-dsh.sh           → /home/jarvis/arrancar-dsh.sh
```

---

## Paso 0 · Ver el plan sin tocar nada

```bash
cd /home/jarvis/jarvis
sudo bash deploy/instalar.sh --dry-run --all
```

## Paso 1 · La SD (lo más urgente)

```bash
sudo bash deploy/instalar.sh --zram
```

Y comprobar que ha funcionado:

```bash
zramctl                 # debe aparecer zram0 con ~450 MB
swapon --show           # zram0 prioridad 100, /var/swap prioridad -2
free -m                 # el "swap used" debería dejar de crecer en la SD
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

## Temas pendientes (deliberadamente NO incluidos)

### El servicio `dsh web` antiguo

`legacy/` contiene una versión corregida, pero **es temporal**: existe sólo
mientras la conversación conceptual siga viviendo en `dsh web`. La decisión
tomada es traer el chat dentro de Jarvis y **retirar** `dsh web`, `socat` y el
redirector Python (ver `projects/sistema-jarvis/conceptual/adaptador-conversacional.md`).

Si necesitas el servicio mientras tanto:

```bash
sudo bash deploy/instalar.sh --legacy
```

Esto **desactiva** `init_deep_deep_seek.service` para que no choquen. No actives
los dos a la vez.

### El `killall` original

Si prefieres no instalar el servicio legacy pero sí arreglar el script actual,
el cambio mínimo es sustituir dentro de `/home/jarvis/arrancar-dsh.sh`:

```bash
killall -9 node socat python3 2>/dev/null     # ← bombardeo indiscriminado
```

por una gestión de PIDs concretos, como hace `legacy/arrancar-dsh.sh`. Mientras
sigas usando el `killall`, **cada reinicio de DSH matará a Jarvis**.
