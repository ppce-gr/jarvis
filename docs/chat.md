# Chat conversacional

El chat es la **fase conceptual** del sistema: donde se habla de una idea antes
de ejecutar nada. Vive dentro de Jarvis (pestaña **Chat**), así que no hace falta
saltar a la interfaz de DSH.

El diseño y las mediciones que llevaron hasta aquí están en
`projects/sistema-jarvis/conceptual/adaptador-conversacional.md`.

---

## Cómo funciona

```text
Navegador  ──POST /chat──────────▶  Jarvis  ──session/prompt──▶  dsh --profile sdk
    ▲                                  │                              │
    └──── SSE /chat/stream ◀───────────┘  ◀── session.event ──────────┘
```

- **Un proceso de DSH por proyecto.** El handshake `initialize` fija el `cwd`
  para todas las sesiones de ese proceso, así que para que el agente trabaje
  dentro de la carpeta del proyecto hace falta uno por proyecto. Se arranca
  perezosamente al primer mensaje y se apaga solo tras 15 minutos de
  inactividad (en una Pi de 905 MB, no podemos dejar procesos vivos).
- **Transporte con el navegador: Server-Sent Events.** Una sola dirección
  (servidor → navegador), sobre HTTP normal, con reconexión automática del
  navegador. ~30 líneas con el módulo `http` nativo.
- **El historial se lee del disco** (`projects/<id>/logs/conversacion.jsonl`),
  así que sobrevive a reinicios de Jarvis.
- **Contexto del proyecto en el primer mensaje:** el adaptador añade un
  preámbulo que le dice al agente dónde está y que el diseño vive en
  `conceptual/`. Sólo en el primero de cada sesión: repetirlo sería ruido.

## Dos cosas que NO se pueden hacer (y por qué)

Verificado leyendo el código de `dsh-sdk-jsonrpc-server`: el protocolo SDK
expone **sólo** `initialize`, `session/prompt` y `shutdown`.

| Limitación | Consecuencia | Mitigación |
|---|---|---|
| **No hay cancelación** | No se puede abortar una respuesta en curso | Botón **Reiniciar**: mata el proceso. El agente olvida lo hablado; el historial en disco se conserva |
| **No hay reanudación** | `createSession` crea un agente **nuevo**; no recarga el transcript | El contexto **durable** vive en las notas de `conceptual/`, no en la memoria del chat |

Es decir: **la memoria del agente dura lo que dura el proceso.** Por eso el
sistema insiste en que los acuerdos se escriban en las notas: eso sí es
permanente, y el agente lo relee.

Si algún día la cancelación fuera imprescindible, la vía sería el perfil `acp`
(que sí tiene `session/cancel`), a cambio de añadir una dependencia.

## Progreso por pasos, no por tokens

Los eventos de sesión se registran al cerrar cada paso (`assistant/message`,
`tool/call`, `turn/end`), no token a token. Para un asistente agéntico esto es
útil: se ve **qué hace** (lee un fichero, lanza tests) además de lo que dice.

Observado en la Pi: respuesta simple en **~1 segundo** con el proceso caliente,
frente a los 16-18 s del modo headless (que arranca un proceso por tarea).

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/projects/:id/chat` | Historial + estado de la sesión |
| `POST` | `/api/projects/:id/chat` | Envía mensaje (`{ text }`) → `202` |
| `POST` | `/api/projects/:id/chat/reset` | Reinicia la conversación |
| `GET` | `/api/projects/:id/chat/stream` | Server-Sent Events |

## Configuración

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_CHAT_PROFILE` | `sdk` | Perfil de DSH para el chat. |
| `JARVIS_CHAT_PROVIDER` | `deepseek-official` | Proveedor del modelo. |
| `JARVIS_CHAT_MODEL` | `deepseek-v4-flash` | Modelo. |
| `JARVIS_CHAT_EFFORT` | `high` | Esfuerzo de razonamiento. |
| `JARVIS_CHAT_IDLE_MS` | `900000` | Inactividad antes de dormir la sesión. |

## Pruebas

`test/infrastructure/conversation.test.js` levanta un **servidor DSH falso**
(`test/helpers/fake-dsh-sdk.js`) que habla el protocolo real por stdio. Se
prueban el framing, las líneas malformadas, los errores, la persistencia, el
preámbulo, el reinicio y el cierre **sin gastar tokens ni necesitar red**.
