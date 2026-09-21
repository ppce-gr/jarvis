# Jarvis · Centro de Mando

Sistema personal de gestión de ideas, proyectos y orquestación de agentes de IA,
diseñado para funcionar con recursos mínimos en una **Raspberry Pi 3B** y para
poder migrarse a hardware más potente sin reescribir nada.

Principios que rigen el proyecto:

- **No reinventar la rueda:** Markdown como formato, Git como respaldo, librerías
  estándar de Node.js para el servidor. Cero dependencias externas de runtime.
- **Arquitectura hexagonal (Puertos y Adaptadores) + SOLID:** el núcleo de negocio
  no sabe qué motor de agentes ni qué almacenamiento hay por debajo.
- **La Pi orquesta, la nube piensa:** el LLM pesado vive detrás de una API.
- **Resiliencia ante la muerte de la SD:** todo se versiona en Git.

---

## Arranque rápido

```bash
# Requiere Node.js 20+ (en la Pi ya está instalado)
npm start
```

Luego abre en tu móvil o PC de la red local:

```
http://<ip-de-la-raspberry>:3081
```

No hay `npm install`: **el proyecto no tiene dependencias de runtime**.

---

## Estructura del repositorio

```text
jarvis/
├── src/
│   ├── domain/                  # Lógica de negocio pura + puertos (interfaces)
│   │   ├── Project.js
│   │   ├── Note.js
│   │   └── ports/               # Contratos: ProjectRepository, NoteRepository,
│   │                            #            Orchestrator, FileBrowser, GitSync
│   ├── application/             # Casos de uso (orquestan el dominio)
│   ├── infrastructure/          # Adaptadores concretos (los "conectores")
│   │   ├── persistence/         # Markdown en disco + explorador de ficheros
│   │   ├── orchestrator/        # Adaptador DSH (agentes)
│   │   ├── git/                 # Respaldo Git
│   │   └── http/                # Servidor web nativo de Node.js
│   └── index.js                 # Raíz de composición (aquí se inyecta todo)
├── public/                      # Interfaz web (HTML/CSS/JS sin frameworks)
├── projects/                    # TUS ideas: Markdown + código + bitácoras
├── docs/                        # Documentación y guías
├── scripts/                     # Despliegue y respaldo
└── test/                        # Suite de pruebas (node:test)
```

---

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/arquitectura-jarvis-pi3.md`](docs/arquitectura-jarvis-pi3.md) | Visión, principios y flujo de trabajo del sistema. |
| [`docs/arquitectura-software.md`](docs/arquitectura-software.md) | Diseño hexagonal, puertos, adaptadores y cómo sustituir DSH. |
| [`docs/manual-interfaz.md`](docs/manual-interfaz.md) | Cómo usar la interfaz web desde el móvil. |
| [`docs/guia-migracion.md`](docs/guia-migracion.md) | Cómo llevarte Jarvis a otro hardware. |

---

## Comandos

```bash
npm start                 # arranca la interfaz web (puerto 3081)
npm run dev               # igual, con recarga automática
npm test                  # ejecuta toda la suite de pruebas
bash scripts/backup.sh    # commit de respaldo en Git (resiliencia SD)
```

Variables de entorno opcionales:

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_PORT` | `3081` | Puerto del servidor web. |
| `JARVIS_HOST` | `0.0.0.0` | Interfaz de red a escuchar. |

---

## Estado

- [x] Dominio y puertos (hexagonal)
- [x] Adaptador de persistencia Markdown (frontmatter + wikilinks)
- [x] Casos de uso de proyectos y notas
- [x] Servidor HTTP sin dependencias
- [x] Interfaz web unificada (árbol, conceptual/código/bitácora, órdenes)
- [x] Respaldo Git y guía de migración
- [ ] Integración real de la orquestación con DSH (adaptador `DshOrchestratorAdapter`)
- [ ] Capa de voz (Web Speech API / Alexa)
