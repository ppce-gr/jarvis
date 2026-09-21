# Chat conversacional (ACP)

El chat es la **fase conceptual** del sistema: donde se habla de una idea antes
de ejecutar nada. Vive dentro de Jarvis (pestaña **Chat**), así que no hace falta
saltar a la interfaz de DSH.

El diseño y las mediciones están en
`projects/sistema-jarvis/conceptual/adaptador-conversacional.md`.

---

## Cómo funciona

```text
Navegador ──POST /chat────────▶ Jarvis ──session/prompt──▶ dsh --profile acp
    ▲                              │                            │
    └─── SSE /chat/stream ◀────────┘ ◀── session/update ────────┘
                                        (deltas de texto, herramientas, permisos)
```

- **Un solo proceso de DSH para todos los proyectos.** A diferencia del protocolo
  SDK (que fijaba el `cwd` en el handshake), ACP lo recibe **por sesión** en
  `session/new`. Un proceso, una sesión por proyecto. En una Pi de 905 MB eso
  ahorra mucha memoria.
- **Streaming real:** ACP manda `agent_message_chunk` con deltas de texto, así
  que la respuesta se ve escribirse, no aparece de golpe. También llegan
  `tool_call` / `tool_call_update` (qué hace el agente) y `agent_thought_chunk`.
- **Memoria que sobrevive:** al abrir un proyecto se busca su sesión persistida y
  se hace `session/resume`. El agente recupera lo hablado aunque Jarvis o el
  proceso de DSH se hayan reiniciado. El `sessionId` se guarda en
  `projects/<id>/logs/acp-session.json`.
- **El historial para la interfaz se lee del disco**
  (`projects/<id>/logs/conversacion.jsonl`), así que se ve aunque el agente
  empiece de cero.

## Por qué ACP y no el protocolo SDK de DSH

DSH expone tres modos de pilotaje y elegimos mal al principio: el perfil `sdk`
tiene sólo tres métodos y **no sabe cancelar ni reanudar**. ACP sí, y además es
un estándar que hablan ~40 agentes.

| | Perfil `sdk` | Perfil `acp` (actual) |
|---|---|---|
| Cancelar una respuesta | No | `session/cancel` |
| Reanudar la memoria | No | `session/resume` |
| Listar sesiones | No | `session/list` |
| Cambiar de modelo en caliente | No | `session/set_config_option` |
| Streaming | Por pasos | **Deltas de texto** |
| `cwd` | Por proceso | **Por sesión** |
| Interoperabilidad | Sólo DSH | ~40 agentes |

El adaptador SDK sigue en el repositorio como alternativa sin dependencias: se
elige con `JARVIS_CHAT_PROTOCOL=sdk`.

## Permisos: el detalle que bloquea si se ignora

ACP invierte una responsabilidad: el servidor **pide** permiso con
`session/request_permission` y **espera respuesta**. Si el cliente no contesta,
el agente se queda colgado para siempre.

Este adaptador responde automáticamente, prefiriendo `allow_always`, y deja
constancia en el chat («🔓 autorizado: …») para que se vea qué se permitió. Es el
mismo nivel de confianza que ya tenía el modo headless, con el aislamiento de
trabajar en la carpeta del proyecto.

## Comportamiento observado en la Pi 3B

Vale la pena distinguir **medido** de **esperado**:

- Respuesta simple con el proceso caliente: **~1-2 s** (medido).
- Reanudación de una conversación creada por el adaptador anterior: **verificada**
  (`session/list` la encontró y `session/resume` la recuperó).
- Memoria tras reiniciar Jarvis por completo: **verificada** — se mató el proceso,
  se rearrancó y el agente recordó el mensaje previo.
- Cancelación: **verificada** — `running` → `cancelled` → `idle` conservando la
  memoria.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/projects/:id/chat` | Historial + estado de la sesión |
| `POST` | `/api/projects/:id/chat` | Envía mensaje (`{ text }`) → `202` |
| `POST` | `/api/projects/:id/chat/cancel` | Detiene el turno en curso |
| `POST` | `/api/projects/:id/chat/reset` | Empieza conversación nueva |
| `GET` | `/api/projects/:id/chat/stream` | Server-Sent Events |

## Configuración

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_CHAT_PROTOCOL` | `acp` | `acp` o `sdk`. |
| `JARVIS_CHAT_PROFILE` | `acp` | Perfil de DSH para el chat. |
| `JARVIS_CHAT_PROVIDER` | `deepseek-official` | Proveedor del modelo. |
| `JARVIS_CHAT_MODEL` | `deepseek-v4-flash` | Modelo. |
| `JARVIS_CHAT_EFFORT` | `high` | Esfuerzo de razonamiento. |
| `JARVIS_CHAT_IDLE_MS` | `900000` | Inactividad antes de dormir el proceso. |

Al dormirse, el proceso se cierra por EOF de stdin (cierre limpio de ACP) y las
sesiones quedan persistidas para reanudarse al siguiente mensaje.

## Pruebas

`test/infrastructure/acp.test.js` levanta un **servidor ACP falso**
(`test/helpers/fake-acp-server.js`) que habla el protocolo real: manda el texto
en trozos, emite el ciclo de vida de las herramientas y —lo más importante—
**pide permisos y espera respuesta**, que es donde un cliente mal hecho se
bloquea. Se prueba sin gastar tokens ni necesitar red.
