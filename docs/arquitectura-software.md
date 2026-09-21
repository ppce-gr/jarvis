# Arquitectura de Software · Jarvis Core

Documento técnico del **cómo está construido** Jarvis. El *qué* y el *por qué*
viven en [`arquitectura-jarvis-pi3.md`](arquitectura-jarvis-pi3.md).

---

## 1. Estilo arquitectónico: Hexagonal (Puertos y Adaptadores)

El sistema se divide en tres anillos concéntricos. La regla de dependencia es
estricta: **las capas internas nunca conocen a las externas**.

```text
        ┌─────────────────────────────────────────────┐
        │              INFRAESTRUCTURA                │
        │  (adaptadores: disco, HTTP, Git, DSH…)      │
        │   ┌─────────────────────────────────────┐   │
        │   │           APLICACIÓN                │   │
        │   │      (casos de uso / puertos)       │   │
        │   │   ┌─────────────────────────────┐   │   │
        │   │   │         DOMINIO             │   │   │
        │   │   │  Project, Note, reglas      │   │   │
        │   │   └─────────────────────────────┘   │   │
        │   └─────────────────────────────────────┘   │
        └─────────────────────────────────────────────┘
```

- **Dominio** (`src/domain/`): entidades y contratos. No importa `fs`, ni `http`,
  ni nada de Node. Es JavaScript puro y testeable en milisegundos.
- **Aplicación** (`src/application/`): casos de uso. Orquestan el dominio a
  través de los puertos. No saben *cómo* se guarda ni *quién* ejecuta.
- **Infraestructura** (`src/infrastructure/`): implementaciones concretas de los
  puertos. Aquí es donde viven DSH, el sistema de ficheros y el servidor web.

### ¿Por qué esto importa en la práctica?

Porque el día que quieras cambiar de motor de agentes, **sólo escribes un
adaptador nuevo** y lo inyectas en `src/index.js`. El dominio, los casos de uso
y la interfaz no se tocan. Lo mismo si mañana quieres guardar en SQLite en lugar
de Markdown, o si te llevas todo a un PC más potente.

---

## 2. Puertos (contratos)

Definidos en `src/domain/ports/`. Un puerto es una clase con métodos que lanzan
`METHOD_NOT_IMPLEMENTED`; sirve de documentación ejecutable del contrato.

| Puerto | Responsabilidad | Adaptador actual | Alternativas futuras |
|---|---|---|---|
| `ProjectRepositoryPort` | Listar/leer/guardar proyectos | `FileSystemProjectRepository` | SQLite, API remota |
| `NoteRepositoryPort` | Notas Markdown (frontmatter + cuerpo) | `FileSystemNoteRepository` | Obsidian REST API, Postgres |
| `OrchestratorPort` | Encolar trabajo de agentes y consultar tareas | `DshHeadlessOrchestratorAdapter` | SDK persistente, API directa |
| `ConversationPort` | Chat persistente por proyecto | `AcpConversationAdapter` | `DshSdkConversationAdapter`, API directa |
| `FileBrowserPort` | Explorar `code/` y `logs/` | `FileSystemBrowserAdapter` | S3, Git remoto |
| `GitSyncPort` | Respaldo y sincronización | `GitSyncAdapter` | Gitea API, rclone |

---

## 3. Casos de uso

| Caso de uso | Entrada | Salida |
|---|---|---|
| `GetProjectsUseCase` | — | Lista de proyectos |
| `GetProjectConceptualTreeUseCase` | `projectId` | Notas + wikilinks extraídos |
| `CreateProjectUseCase` | `{ name, description }` | Proyecto con `_indice` y `qa-dudas` |
| `SaveNoteUseCase` | `{ projectId, noteId, title, content }` | Nota persistida |
| `BrowseProjectFilesUseCase` | `projectId`, `zone` | Árbol de ficheros / contenido |
| `RunOrchestratorTaskUseCase` | `projectId`, `instruction` | Acuse (encola, no espera) |
| `ListOrchestratorTasksUseCase` | `projectId` | Estado de las tareas |
| `SendChatMessageUseCase` | `projectId`, `text` | Acuse del chat |
| `GetChatHistoryUseCase` | `projectId` | Mensajes + estado de sesión |
| `SubscribeChatUseCase` | `projectId`, listener | Cancelar suscripción (SSE) |
| `ResetChatUseCase` | `projectId` | Reinicia la conversación |
| `CancelChatTurnUseCase` | `projectId` | Detiene el turno en curso |
| `GetGitStatusUseCase` | — | Estado del repositorio |

---

## 4. Adaptadores de entrada: HTTP

`JarvisWebServer` usa exclusivamente el módulo `http` nativo. Decisiones:

- **Cero dependencias**: nada de Express. Menos RAM, menos disco, menos superficie.
- **UI estática en `public/`**: el navegador del usuario renderiza; la Pi sólo
  entrega bytes. Esto es clave en una Pi 3B.
- **Validación en el borde**: tamaño máximo de payload (256 KB), zonas permitidas
  y bloqueo de *path traversal* antes de tocar el disco.

### API REST

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Comprobación de vida |
| `GET` | `/api/projects` | Lista proyectos |
| `POST` | `/api/projects` | Crea proyecto (`{ name, description }`) |
| `GET` | `/api/projects/:id/conceptual` | Árbol conceptual con wikilinks |
| `GET` | `/api/projects/:id/conceptual/:noteId` | Nota individual |
| `PUT` | `/api/projects/:id/conceptual/:noteId` | Guarda nota |
| `GET` | `/api/projects/:id/files?zone=code\|logs` | Lista ficheros de la zona |
| `GET` | `/api/projects/:id/files/content?zone&path` | Contenido de un fichero |
| `GET` | `/api/projects/:id/tasks` | Estado de las tareas del orquestador |
| `POST` | `/api/projects/:id/orchestrate` | Encola orden (`{ instruction }`) → `202` |
| `GET` | `/api/projects/:id/chat` | Historial + estado del chat |
| `POST` | `/api/projects/:id/chat` | Envía mensaje (`{ text }`) → `202` |
| `POST` | `/api/projects/:id/chat/cancel` | Detiene el turno en curso |
| `POST` | `/api/projects/:id/chat/reset` | Reinicia la conversación |
| `GET` | `/api/projects/:id/chat/stream` | Server-Sent Events del chat |
| `GET` | `/api/git/status` | Estado del respaldo Git |

---

## 5. Formato de las notas (contrato con Obsidian)

Cada nota es un `.md` con frontmatter YAML simple y cuerpo Markdown:

```markdown
---
title: "Subidea de autenticación"
status: "activa"
parent: "[[_indice]]"
---

# Subidea de autenticación

Enlaza con [[_indice]] y [[qa-dudas]].
```

- El parser de frontmatter es **deliberadamente minimalista** (pares `clave: valor`).
  Evita meter un parser YAML completo en una Pi 3B. Si algún día necesitas YAML
  complejo, se sustituye en el adaptador sin tocar el dominio.
- Los `[[wikilinks]]` se extraen del cuerpo (ignorando bloques y código en línea)
  y alimentan el grafo de ideas.

---

## 6. Cómo sustituir el motor de agentes

El motor actual es DeepSeek Harness en modo `headless`; el análisis completo de
las alternativas y las mediciones están en [`integracion-dsh.md`](integracion-dsh.md).

1. Crea `src/infrastructure/orchestrator/MiNuevoAdapter.js` que extienda
   `OrchestratorPort` e implemente `executeTask(projectId, instruction)` y
   `listTasks(projectId)`.
2. En `src/index.js`, cambia una línea:

```js
// antes
const orchestratorAdapter = new DshHeadlessOrchestratorAdapter({ workspaceRoot });
// después
const orchestratorAdapter = new MiNuevoAdapter(config);
```

3. Listo. Ni un caso de uso, ni la interfaz, ni el dominio se enteran.

Lo mismo aplica a la capa de voz futura: será un **adaptador de entrada** nuevo
(por ejemplo `AlexaSkillAdapter`) que traducirá voz a los mismos casos de uso.

---

## 7. Estrategia de pruebas

```bash
npm test
```

- **Dominio y aplicación** se prueban con dobles en memoria
  (`test/helpers/InMemoryRepositories.js`): sin disco, sin red, milisegundos.
- **Infraestructura** se prueba contra directorios temporales reales
  (`fs.mkdtemp`), incluyendo los casos de seguridad (path traversal).
- **El orquestador** se prueba con un `runner` inyectado
  (`test/infrastructure/orchestrator.test.js`): verifica la cola de uno, la
  bitácora, los estados y los timeouts **sin lanzar DSH ni gastar tokens**.

Esto es posible *precisamente* porque el dominio no depende de la infraestructura.
