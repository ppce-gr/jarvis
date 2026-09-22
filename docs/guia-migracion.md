# Guía de migración a otro hardware

Objetivo: llevarte Jarvis completo (ideas, código, bitácoras y programa) a otra
máquina —una Pi más potente, un mini-PC, un servidor casero— en pocos minutos.

Todo el sistema es **portable por diseño**: no hay base de datos, ni rutas
absolutas grabadas a fuego, ni dependencias compiladas.

---

## 1. Antes de migrar: sube todo a Git

**Ya está configurado y verificado:**

| Repositorio | Remoto | Visibilidad |
|---|---|---|
| Código | `git@github.com:<usuario>/jarvis.git` | Público |
| Memoria | `git@github-vault:<usuario>/jarvis-vault.git` | **Privado** |

Cada uno usa su **propia deploy key con escritura** (`~/.ssh/jarvis_deploy` y
`~/.ssh/vault_deploy`). GitHub **no permite reutilizar una deploy key en dos
repositorios**, y además conviene que no lo haga: así una filtración del vault no
compromete el repo público.

Hace falta un alias en `~/.ssh/config`; **es lo que le dice a git qué clave usar
en cada repositorio**, y sin él el push de la memoria falla con «Could not
resolve hostname github-vault»:

```sshconfig
Host github.com
  IdentityFile ~/.ssh/jarvis_deploy
  IdentitiesOnly yes

Host github-vault
  HostName github.com
  IdentityFile ~/.ssh/vault_deploy
  IdentitiesOnly yes
```

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
git clone git@github.com:<usuario>/jarvis.git jarvis        # código
git clone git@github-vault:<usuario>/jarvis-vault.git jarvis-vault   # memoria
cd jarvis
export JARVIS_BRAIN_DIR="$(cd ../jarvis-vault && pwd)"
npm test        # 66 pruebas: confirma que el sistema revivió
npm start
```

No hace falta `npm install`: el proyecto no tiene dependencias de runtime.

**Lo que NO viene en el clon** (y hay que recrear a mano):

| Qué | Dónde |
|---|---|
| Cuenta y repositorios en GitHub | — |
| Clave SSH de cada repositorio | `~/.ssh/jarvis_deploy`, `~/.ssh/vault_deploy` |
| Config SSH con los alias | `~/.ssh/config` |
| Credenciales del modelo | `~/.dsh/.credentials.yaml` |

Todo lo demás —código, notas, configuración de modelo y bitácoras— está en los
repositorios. Si desplegaste el sistema en una máquina concreta, el manual de
operación de esa máquina vive en el repositorio privado (`OPERACIONES.md`).

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

**Y una comprobación que ahorra disgustos:** después de instalar `dsh`, ejecuta
`dsh --profile headless "OK"` antes de dar nada por bueno. Un `dsh` mal instalado
no falla al instalarse: falla al arrancar, y entonces el servicio queda muerto
sin explicación evidente.

### El CLI `dsh` (imprescindible para orquestar)

Jarvis usa `dsh` para lanzar a los agentes. La interfaz web funciona sin él, pero
las conversaciones y las órdenes fallarán. Comprueba e instala:

```bash
command -v dsh || npm install -g @deepseek-ai/dsh@0.1.5-rc.3
dsh --profile headless "responde OK"   # prueba; la primera vez auto-inicializa el perfil
```

#### ⚠️ Instala la versión más NUEVA de la familia, no una anterior

`@deepseek-ai/dsh` declara sus plugins con rangos `^`, así que si instalas una
versión **antigua** del core, npm trae plugins **más nuevos** que él. Esa mezcla
rompe el arranque con un error que no dice nada de versiones:

```text
dsh: cannot create effect on inactive context
Error: plugin(s) failed to load: @deepseek-ai/dsh-sandbox-local
```

Comprobado en la práctica: instalar `0.1.5-rc.2` trajo `dsh-base` y
`dsh-tool-cordis` en `0.1.5-rc.3`, y no arrancaba. Con todo en `0.1.5-rc.3`
funciona.

Para verificar que una instalación es coherente, cuenta las versiones:

```bash
find "$(npm root -g)/@deepseek-ai/dsh" -name package.json \
  -path "*/@deepseek-ai/*" -exec grep -h '"version"' {} \; | sort | uniq -c
```

Debe salir **una sola versión**. Si salen varias, el arranque fallará.

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
| `<memoria>/*/logs/*.log` | Registro histórico de agentes | **Sí conviene versionarlos**: son la bitácora |
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
