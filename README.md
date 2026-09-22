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

npm test         # 66 pruebas
npm start        # http://<ip>:3081
```

No hay `npm install`: el proyecto no tiene dependencias de runtime.

## Estructura

```text
src/
├── domain/            entidades y puertos (contratos puros, sin Node)
├── application/       casos de uso
├── infrastructure/    adaptadores: disco, HTTP, Git, DSH
└── index.js           raíz de composición (aquí se inyecta todo)
public/                interfaz web (HTML/CSS/JS sin frameworks)
docs/                  arquitectura, integración, manual y guía de migración
deploy/                unidades systemd, zram y guía de despliegue
scripts/               respaldo y despliegue
test/                  pruebas (node:test), 66 en verde
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
| [`deploy/README.md`](deploy/README.md) | Instalación de servicios y zram. |

## Configuración

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_PORT` | `3081` | Puerto del servidor web. |
| `JARVIS_HOST` | `0.0.0.0` | Interfaz de red. |
| `JARVIS_BRAIN_DIR` | `../jarvis-vault` | Dónde vive la memoria. |
| `JARVIS_DSH_BIN` | `dsh` | Binario de DeepSeek Harness. |
| `JARVIS_DSH_PROFILE` | `headless` | Perfil para orquestar. |
| `JARVIS_CHAT_PROTOCOL` | `acp` | `acp` o `sdk`. |
| `JARVIS_CHAT_MODEL` | `deepseek-v4-flash` | Modelo (luego manda el selector). |
| `JARVIS_CHAT_IDLE_MS` | `900000` | Inactividad antes de dormir la conversación. |
| `JARVIS_PERMISSION_TIMEOUT_MS` | `120000` | Tope para contestar un permiso. |
| `JARVIS_STALL_TIMEOUT_MS` | `600000` | Aviso si un turno lleva mucho sin emitir. |

## Estado

- [x] Dominio y puertos (hexagonal), 66 pruebas en verde
- [x] Interfaz web sin frameworks: ideas, notas, código, bitácora y chat
- [x] Chat persistente sobre **ACP**: streaming por deltas, cancelación real y
      memoria que sobrevive al reinicio
- [x] Selector de modelo alimentado por el catálogo que publica el motor
- [x] Orquestación con agentes, cola de uno y bitácora en vivo
- [x] Respaldo automático de los dos repositorios
- [x] **Autoactualización con reversión**: cinco barreras, verificación de arranque y reversión automática
- [ ] Capa de voz

## Licencia

MIT.
