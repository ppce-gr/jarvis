# DSH web: el agente desde el móvil

`jarvis.service` sirve la **interfaz de ideas** en el puerto 3081. Aparte, el
**DSH web** es la interfaz propia del motor de agentes, pensada para abrirse
desde el móvil con un enlace fijo.

```text
móvil ──► :8080  redireccionar.py  ──302──►  :3085  socat  ──►  :3080  dsh web
          (puerto público fijo)              (proxy)             (token nuevo
                                                                  en cada arranque)
```

El redirector existe porque el token de `dsh web` **cambia en cada arranque**:
así el usuario guarda una sola URL (`http://<IP>:8080`) y nunca copia el token.

## Qué se instala

| Fichero | Qué es |
|---|---|
| `deploy/dsh-web/arrancar-dsh.sh` | Arranque versionado: limpia, lanza `dsh web`, captura el token, levanta proxy y redirector. |
| `deploy/dsh-web/redireccionar.py` | Redirector 302 del puerto público al proxy. |
| `deploy/systemd/jarvis-dsh-web.service.in` | Unidad (plantilla) que ejecuta el arranque como el usuario de Jarvis. |
| `deploy/instalar-dsh-web.sh` | Instalador y desinstalador. |

```bash
sudo bash deploy/instalar-dsh-web.sh
# ... y para volver atrás:
sudo bash deploy/instalar-dsh-web.sh --quitar
```

El instalador **retira** la unidad antigua `init_deep_deep_seek.service` y deja
una copia del arranque viejo en `~/arrancar-dsh.sh.antes-jarvis-dsh-web`.

## El incidente que motivó versionarlo

El arranque vivía suelto en el HOME y empezaba así:

```bash
killall -9 node socat python3
```

`jarvis.service` corre **con el mismo usuario** (`jarvis`) y su proceso es
`node`, así que ese `killall` mataba a Jarvis en cada arranque. systemd lo
reiniciaba a los 5 s (`Restart=on-failure`), pero la sesión del agente moría con
él. El registro lo enseñaba sin lugar a dudas:

```text
13:12:00  Started init_deep_deep_seek.service
13:12:00  jarvis.service: Main process exited, code=killed, status=9/KILL
```

La limpieza ahora es **dirigida** (`pkill -9 -f` con patrones propios de este
servicio: `@deepseek-ai/dsh`, `dsh web --no-open`, `redireccionar.py` y su
`socat`) y nunca toca `node` a secas. Hay una prueba que lo vigila.

## Configuración

Se lee de `/etc/jarvis/jarvis.conf` (o del entorno) al instalar, y queda escrita
en la unidad. Todas tienen valor por defecto:

| Variable | Por defecto | Qué es |
|---|---|---|
| `JARVIS_DSH_WEB_HOST` | autodetecta (`hostname -I`) | IP o nombre del enlace |
| `JARVIS_DSH_WEB_VERSION` | `0.2.0-rc.2` | Versión **fijada** de `@deepseek-ai/dsh` |
| `JARVIS_DSH_WEB_MAX_OLD_SPACE` | `384` | Tope de heap de V8, en MB |
| `JARVIS_DSH_WEB_PORT` | `3080` | Puerto interno de `dsh web` |
| `JARVIS_DSH_WEB_PROXY_PORT` | `3085` | Puerto del proxy `socat` |
| `JARVIS_DSH_WEB_PUBLIC_PORT` | `8080` | Puerto público del redirector |

**Nunca `@latest`.** Con `@latest`, cada arranque re-resuelve el paquete y puede
descargarlo: lento, impredecible y con picos de memoria en una Pi de 905 MB.
La versión se fija a propósito.

## Comprobar y depurar

```bash
systemctl status jarvis-dsh-web.service --no-pager
/usr/local/lib/jarvis/dsh-web/arrancar-dsh.sh comprobar   # configuración resuelta
/usr/local/lib/jarvis/dsh-web/arrancar-dsh.sh limpiar     # sólo limpiar y salir
```

El registro del arranque se ve en el journal (`journalctl -u jarvis-dsh-web -f`).
El fichero con el **token** se crea con permisos `0600` (contiene un secreto).

## Relación con los permisos de root

Este arranque **no necesita root**: corre como el usuario `jarvis`, igual que el
servicio. Editar `/etc`, reiniciar servicios o tocar GPIO sigue pasando por el
sistema de permisos con PIN (`docs/permisos.md`).
