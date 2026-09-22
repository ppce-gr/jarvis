# Guía de migración a otro hardware

Objetivo: llevarte Jarvis completo (ideas, código, bitácoras y programa) a otra
máquina —una Pi más potente, un mini-PC, un servidor casero— en pocos minutos.

Todo el sistema es **portable por diseño**: no hay base de datos, ni rutas
absolutas grabadas a fuego, ni dependencias compiladas.

---

## 1. Antes de migrar: sube todo a Git

**Ya está configurado y verificado:**

| Dato | Valor |
|---|---|
| Remoto | `git@github.com:ppce-gr/jarvis.git` (privado) |
| Propiedad | Cuenta del usuario |
| Credencial | Clave SSH dedicada `~/.ssh/jarvis_deploy`, como **deploy key con escritura** |

Se eligió SSH y no un token porque **las claves no caducan**: un token caducado
pararía el respaldo automático **en silencio**, que es el peor fallo posible en
un sistema de respaldo.

Comprobar el estado en cualquier momento:

```bash
bash scripts/backup.sh     # commit + push si hay cambios
git log --oneline -1 origin/main
```

### Restauración desde cero (procedimiento probado)

```bash
git clone git@github.com:ppce-gr/jarvis.git jarvis
cd jarvis
npm test        # 66 pruebas: confirma que el sistema revivió
npm start
```

No hace falta `npm install`: el proyecto no tiene dependencias de runtime.

**Lo que NO viene en el clon** (y hay que recrear): `~/.dsh` con las credenciales
de los modelos, y `~/.ssh/jarvis_deploy` con la clave. El resto —código, notas,
configuración de modelo y bitácoras— está en el repositorio.

### Respaldo automático

```bash
sudo bash deploy/instalar.sh --backup
systemctl list-timers jarvis-backup.timer
```

Commitea y sube cada 30 minutos.`

> **¿Un repo o varios?** Uno solo. Este repositorio contiene el programa, la
> documentación y tus ideas. Un único `git clone` te devuelve el sistema entero.
> Si algún proyecto concreto crece y quieres su propio repo, puede convertirse
> en un remoto adicional, pero el repo raíz siempre debe poder reconstruir todo.

---

## 2. En la máquina nueva

Requisitos: **Node.js 20 o superior**, **Git** y el **CLI de DeepSeek Harness**.

```bash
git clone <url-de-tu-repo> jarvis
cd jarvis
npm test        # verifica que todo está sano
npm start       # arranca la interfaz
```

No hay `npm install` porque no hay dependencias de runtime. Si en el futuro se
añaden, este paso aparecerá aquí y en `scripts/deploy.sh`.

### El CLI `dsh` (imprescindible para orquestar)

Jarvis usa `dsh` para lanzar a los agentes. La interfaz web funciona sin él, pero
las órdenes de la barra ⌘ fallarán. Comprueba e instala:

```bash
command -v dsh || npm install -g @deepseek-ai/dsh
dsh --profile headless "responde OK"   # prueba; la primera vez auto-inicializa el perfil
```

La primera ejecución crea `~/.dsh/profiles/headless` **sin red y sin
`pnpm install`** (usa un symlink a la propia instalación de DSH).

> **Ojo con el servicio systemd:** si `dsh` no está instalado globalmente, el
> PATH del servicio no lo encontrará. El instalador
> `deploy/instalar.sh --jarvis` detecta la ruta y la inyecta en la unidad
> automáticamente. Si lo haces a mano, ajusta `Environment=JARVIS_DSH_BIN=`.

---

## 3. Qué NO viaja por Git (y por qué da igual)

| Elemento | Motivo | Qué hacer |
|---|---|---|
| `projects/*/logs/*.log` | Registro histórico de agentes | **Sí conviene versionarlos**: son la bitácora |
| Ficheros temporales | Basura | Ignorados por `.gitignore` |
| El propio `node_modules` | No existe (cero dependencias) | — |
| `.dsh-home/` | DSH_HOME local de pruebas (contiene credenciales) | Nunca versionar; está en `.gitignore` |

Todo lo que define el sistema (código, docs, ideas, servicios, scripts) **sí**
viaja en el repositorio.

---

## 4. Comprobaciones tras migrar

```bash
npm test                                  # 19 pruebas en verde
curl -s localhost:3081/api/health         # {"status":"ok"}
curl -s localhost:3081/api/projects       # aparecen tus ideas
```

Abre `http://<nueva-ip>:3081` y verifica que ves tus proyectos y notas.

---

## 5. Si quieres arranque automático

Todo lo que va a `/etc` está preparado en `deploy/`, con un instalador idempotente
que además detecta la ruta real del binario `dsh`:

```bash
cd ~/jarvis
sudo bash deploy/instalar.sh --dry-run --all   # ver el plan sin tocar nada
sudo bash deploy/instalar.sh --dsh-global      # CLI fijado (recomendado primero)
sudo bash deploy/instalar.sh --zram            # swap comprimido en RAM
sudo bash deploy/instalar.sh --jarvis          # interfaz en el puerto 3081
sudo bash deploy/instalar.sh --backup          # respaldo Git cada 30 min
```

El detalle de cada paso y las comprobaciones están en
[`deploy/README.md`](../deploy/README.md).

Si prefieres hacerlo a mano:

```bash
sudo cp deploy/systemd/jarvis.service /etc/systemd/system/jarvis.service
sudo nano /etc/systemd/system/jarvis.service   # ajusta User, rutas y JARVIS_DSH_BIN
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis
```

Para el respaldo periódico en Git, la vía limpia es el temporizador:

```bash
sudo cp deploy/systemd/jarvis-backup.{service,timer} /etc/systemd/system/
sudo systemctl enable --now jarvis-backup.timer
```

O, si lo prefieres por cron:

```bash
crontab -e
# cada 30 minutos, commit de seguridad
*/30 * * * * /home/<usuario>/jarvis/scripts/backup.sh
```

---

## 6. Notas específicas de la Raspberry Pi 3B

- **Memoria:** el proceso en reposo consume muy poco (servidor `http` nativo y
  ficheros estáticos). No instales frameworks pesados.
- **SD:** cuanto más se escriba, antes se desgasta. Mantén los logs pequeños y
  evita el *watch* permanente (`npm run dev`) en producción.
- **Nube:** el LLM vive detrás de una API. Si algún día montas un modelo local
  en un PC potente, sólo tienes que escribir un `OrchestratorPort` nuevo que
  apunte a ese servidor: el resto del sistema no cambia.
