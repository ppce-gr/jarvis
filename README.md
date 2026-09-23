# Jarvis

Un **centro de mando personal** para llevar ideas desde la conversación hasta el
código, con agentes de IA que trabajan sobre tus propios ficheros. Pensado para
funcionar en hardware humilde —una **Raspberry Pi 3B**— sin bases de datos, sin
dependencias de runtime y sin depender de servicios externos más allá del modelo.

> Este repositorio es el **motor**. El segundo cerebro (las notas, las
> conversaciones y las bitácoras) vive en un repositorio **privado** aparte, para
> que lo público sea publicable de verdad.

---

## Por qué existe

Las interfaces de chat lineales se quedan cortas cuando tienes muchas ideas a la
vez: todo se mezcla en un hilo infinito. Jarvis en lugar de eso organiza el
trabajo en **proyectos**, separa la **fase conceptual** (hablar de la idea) de la
**fase de ejecución** (picar código), y deja **bitácora** de lo que hicieron los
agentes.

## Arquitectura en dos repositorios

```text
jarvis/          este repositorio · PÚBLICO · el motor
jarvis-vault/    repositorio privado · la memoria (notas, conversaciones, bitácoras)
```

El motor apunta a la memoria con `JARVIS_BRAIN_DIR`. Por defecto busca una
carpeta **hermana** llamada `jarvis-vault`, de modo que código y datos no
comparten árbol de Git: **es imposible que un fallo de `.gitignore` publique tus
notas.**

## Principios

1. **Arquitectura hexagonal (puertos y adaptadores) + SOLID.** El dominio no sabe
   si por debajo hay DSH, HTTP o el sistema de ficheros. Cambiar de motor de
   agentes es escribir un adaptador, no reescribir el sistema.
2. **Cero dependencias de runtime.** `npm start` funciona sin `npm install`.
   Servidor HTTP con el módulo nativo de Node.
3. **La Pi orquesta, la nube piensa.** El modelo pesado vive detrás de una API.
4. **Markdown plano como formato.** Frontmatter y `[[wikilinks]]`: legible por
   humanos, por agentes y por Obsidian si algún día te apetece.
5. **No reinventar la rueda.** Markdown, Git, `http` nativo, `spawn` nativo.
6. **Resiliencia ante la muerte de la SD.** Todo versionado en Git, con respaldo
   automático de los dos repositorios.

## Cómo funciona

```text
                    ┌──────────────────────────────────────┐
   Navegador ──────▶│  Jarvis (HTTP nativo, puerto 3081)   │
   (móvil o PC)     └───────────────┬──────────────────────┘
        ▲                           │
        │ SSE                       ├── ConversationPort ──▶ dsh --profile acp
        │ (streaming)               │   (chat persistente)    (memoria, cancelación)
        └───────────────────────────┤
                                    └── OrchestratorPort ──▶ dsh --profile headless
                                        (ejecución)           (una tarea y se apaga)
```

Dos puertos separados a propósito, porque son ciclos de vida opuestos:

| Puerto | Para qué | Ciclo de vida |
|---|---|---|
| `ConversationPort` | Conversar: la fase conceptual | Proceso vivo, con memoria |
| `OrchestratorPort` | Ejecutar: lanzar agentes | Una tarea y se apaga, cola de uno |

## Arranque rápido

Requiere **Node.js 20+** y, para orquestar, el CLI de DeepSeek Harness.

```bash
git clone <tu-repo>/jarvis.git
cd jarvis

# La memoria, en una carpeta hermana
git clone <tu-repo-privado>/jarvis-vault.git ../jarvis-vault

npm test         # 106 pruebas
npm start        # http://<ip>:3081
```

No hay `npm install`: el proyecto no tiene dependencias de runtime.

Para instalarlo como servicio, y opcionalmente decirle **quién** lo ejecuta y
**dónde** están las cosas:

```bash
./deploy/configurar.sh              # deduce los valores y te los propone
sudo bash deploy/instalar.sh --all
```

Configurar es **opcional**: si no lo haces, todo se deduce del sitio donde esté
el repositorio y de tu usuario. El asistente sólo hace falta para salirse de lo
normal, y la configuración vive en `deploy/jarvis.conf` (ignorado por Git), así
que cada cual configura su clon sin tocar el repositorio.

## Estructura

```text
src/
├── domain/            entidades y puertos (contratos puros, sin Node)
├── application/       casos de uso
├── infrastructure/    adaptadores: disco, HTTP, Git, DSH
└── index.js           raíz de composición (aquí se inyecta todo)
public/                interfaz web (HTML/CSS/JS sin frameworks)
docs/                  arquitectura, integración, manual y guía de migración
deploy/                asistente de configuración, unidades systemd, zram y guía
scripts/               actualizador con reversión y respaldo en Git
test/                  pruebas (node:test), 106 en verde
```

## Actualización y automodificación

Jarvis **se actualiza sola**, y está pensada para poder modificar su propio
código sin que un cambio roto deje la máquina inservible. Todo el mecanismo vive
en [`deploy/`](deploy/) y [`scripts/`](scripts/).

- **Pedir una actualización no necesita privilegios:** basta con escribir la
  **bandera de actualización** (por defecto `.update-request`, en la carpeta que
  contiene el repositorio; o pulsar el botón del panel). Un `.path`
  de systemd lo detecta y lanza el actualizador **fuera** del árbol de procesos
  de Jarvis, para que sobreviva al reinicio del servicio y pueda comprobar si el
  arranque funcionó.
- **Cinco barreras, en orden de coste:** árbol limpio → respaldo → `--ff-only` →
  `npm test` **y** un arranque real en un puerto aparte → reinicio verificado.
  Si algo falla, revierte al último commit bueno.
- **Lo único con privilegios** es una regla de sudoers que permite
  `systemctl restart jarvis.service`, y nada más.
- **El actualizador se pone al día a sí mismo** justo antes de ejecutarse, así que
  no hay que reinstalarlo a mano cada vez que cambia.
- **Cuando algo falla deja un post-mortem** legible
  (`.update-state/ultimo-fallo.txt`) con la fase, el error y a dónde se volvió,
  pensado para poder pedirle a Jarvis que lo revise y lo arregle.

Para instalarlo, usarlo y entenderlo:

| Documento | Qué encontrarás |
|---|---|
| [`deploy/README.md`](deploy/README.md) | **La guía práctica**: qué se instala, el script de mantenimiento y todas sus órdenes, y el post-mortem. |
| [`docs/autoactualizacion.md`](docs/autoactualizacion.md) | **El diseño**: las barreras, las relaciones entre ramas, los riesgos y el porqué de cada decisión. |

El script de mantenimiento reúne las operaciones en un solo sitio:

```bash
./deploy/mantenimiento.sh ayuda      # lista todas las órdenes
./deploy/mantenimiento.sh estado     # empieza siempre por aquí
./deploy/mantenimiento.sh instalar   # lo copia a ~/mantenimiento.sh
```

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/arquitectura-jarvis-pi3.md`](docs/arquitectura-jarvis-pi3.md) | Visión, principios y flujo de trabajo. |
| [`docs/arquitectura-software.md`](docs/arquitectura-software.md) | Diseño hexagonal, puertos, adaptadores y API REST. |
| [`docs/chat.md`](docs/chat.md) | El chat: ACP, streaming, permisos y límites. |
| [`docs/integracion-dsh.md`](docs/integracion-dsh.md) | Cómo se conecta con DSH, con mediciones reales. |
| [`docs/manual-interfaz.md`](docs/manual-interfaz.md) | Uso desde el móvil. |
| [`docs/autoactualizacion.md`](docs/autoactualizacion.md) | **Autoactualización con reversión**: método, barreras y riesgos. |
| [`docs/guia-migracion.md`](docs/guia-migracion.md) | Llevarlo a otro hardware y restaurarlo. |
| [`deploy/README.md`](deploy/README.md) | Instalación de servicios, zram, **autoactualización** y guía del script de mantenimiento. |

## Configuración

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_PORT` | `3081` | Puerto del servidor web. |
| `JARVIS_HOST` | `0.0.0.0` | Interfaz de red. |

Todas las variables están documentadas, con sus valores por defecto, en
[`deploy/jarvis.conf.example`](deploy/jarvis.conf.example). El despliegue usa
además `deploy/jarvis.conf` para las rutas del sistema, que genera el asistente.

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_BRAIN_DIR` | `../jarvis-vault` | Dónde vive la memoria. |
| `JARVIS_DSH_BIN` | `dsh` | Binario de DeepSeek Harness. |
| `JARVIS_DSH_PROFILE` | `headless` | Perfil para orquestar. |
| `JARVIS_CHAT_PROTOCOL` | `acp` | `acp` o `sdk`. |
| `JARVIS_CHAT_MODEL` | `deepseek-v4-flash` | Modelo (luego manda el selector). |
| `JARVIS_CHAT_IDLE_MS` | `900000` | Inactividad antes de dormir la conversación. |
| `JARVIS_PERMISSION_TIMEOUT_MS` | `120000` | Tope para contestar un permiso. |
| `JARVIS_STALL_TIMEOUT_MS` | `600000` | Aviso si un turno lleva mucho sin emitir. |

## Estado

- [x] Dominio y puertos (hexagonal), 106 pruebas en verde
- [x] Interfaz web sin frameworks: ideas, notas, código, bitácora y chat
- [x] Chat persistente sobre **ACP**: streaming por deltas, cancelación real y
      memoria que sobrevive al reinicio
- [x] Selector de modelo alimentado por el catálogo que publica el motor
- [x] Orquestación con agentes, cola de uno y bitácora en vivo
- [x] Respaldo automático de los dos repositorios: la memoria se autosalva, el
      código sólo se sube (se commitea a propósito)
- [x] **Autoactualización con reversión**: cinco barreras, verificación de arranque
      en un puerto aparte, reversión real y post-mortem de los fallos
- [ ] Capa de voz

## Licencia

MIT.
