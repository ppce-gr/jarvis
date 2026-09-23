# Chat conversacional (ACP)

El chat es la **fase conceptual** del sistema: donde se habla de una idea antes
de ejecutar nada. Vive dentro de Jarvis (pestaña **Chat**), así que no hace falta
saltar a la interfaz de DSH.

El diseño y las mediciones están en
las notas de diseño del proyecto (en la memoria).

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
  `<memoria>/<id>/logs/acp-session.json`.
- **El historial para la interfaz se lee del disco**
  (`<memoria>/<id>/logs/conversacion.jsonl`), así que se ve aunque el agente
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
`session/request_permission` y **espera respuesta**. Un cliente que no conteste
deja al agente colgado **para siempre**.

Hay **tres** redes de seguridad, porque de este punto depende que el chat no se
quede muerto:

1. **Respuesta inmediata.** El adaptador contesta en el momento, prefiriendo
   `allow_always`, y lo deja visible en el chat («🔓 autorizado: read_file») para
   que se vea qué se permitió.
2. **Temporizador de seguridad** (`JARVIS_PERMISSION_TIMEOUT_MS`, 2 min por
   defecto). Si por lo que sea un permiso se quedara sin contestar, al vencer se
   responde con la opción **más conservadora** disponible y se avisa en el chat.
   Mejor rechazar una herramienta que dejar el turno colgado.
3. **Drenaje al cerrar.** Si Jarvis se apaga con permisos pendientes, los
   contesta antes de terminar el proceso. Sin esto, DSH esperaría
   indefinidamente y no cerraría nunca.

Además hay un **vigilante de turno mudo** (`JARVIS_STALL_TIMEOUT_MS`, 10 min):
si un turno lleva mucho tiempo sin emitir nada, se avisa en el chat. **No
cancela nada** a propósito: una tarea legítima (tests, instalación) puede estar
minutos trabajando en silencio.

## «Si salgo y vuelvo, vuelve al origen»

Los eventos SSE **no se reenvían**: si el móvil se queda sin cobertura o el
navegador suspende la pestaña, lo que ocurrió en ese hueco no llega. La única
fuente fiable es el disco. Por eso la interfaz hace tres cosas:

1. **Al abrir un proyecto** lee historial y estado del servidor.
2. **Al reconectar el stream** (`onopen`) vuelve a leerlos. EventSource
   reconecta solo, así que una caída breve se recupera sin intervención.
3. **Al volver a la pestaña** (`visibilitychange`) también, porque los móviles
   suspenden las conexiones en segundo plano.

En el lado del servidor no hay estado que se pueda quedar descolgado: si el
proceso de DSH muere, la sesión queda `stopped` y el siguiente mensaje la
reanuda desde el disco.

## Elegir modelo y esfuerzo de razonamiento

DSH publica un **catálogo** de modelos en cada sesión (en esta instalación:
**26 modelos** de `deepseek-official` y `google`).

Jarvis lo expone y ofrece un **selector en la cabecera del chat**. La elección se
guarda en `chat-config.json` (versionado a propósito: es parte de «cómo tengo el
sistema» y debe sobrevivir a la muerte de la SD) y se aplica a las sesiones
vivas en el siguiente turno.

Sin elegir nada, el valor inicial sale de `JARVIS_CHAT_MODEL` y
`JARVIS_CHAT_EFFORT`.

### Qué modelos funcionan y cuáles no

Al poner una API key, el motor descubre **muchos** modelos y no todos valen.
Jarvis mantiene un registro de salud (`<memoria>/model-health.json`) y actúa
según el tipo de fallo:

| Estado | Qué significa | Cómo se muestra |
|---|---|---|
| `ok` | Responde | 🟢 arriba, entre los disponibles |
| `quota` | Se agotó la cuota/el saldo de la cuenta | 🟡 arriba, marcado «sin cuota» |
| `broken` | No existe, no está disponible o no es accesible | 🔴 abajo, bajo «No funcionan» |
| `unknown` | Sin confirmar (fallo transitorio, red, credencial, límite temporal) | ⚪ **abajo**, «sin confirmar» |

Los modelos **sin confirmar cuentan como no disponibles**: hasta que una
comprobación no diga lo contrario, se muestran con los que no funcionan.

El registro se alimenta de dos formas:

1. **De los fallos reales**: si un turno del chat falla porque el modelo no
   existe, se marca como roto; si falla por cuota, se marca pero se conserva.
2. **De una comprobación activa**: la sección **Admin** lanza un turno mínimo
   contra todos los modelos, y el botón **⟳** de cada fila del selector
   comprueba **sólo ese modelo**, sin tocar el resto.

### Cómo se presenta el selector

El selector de modelos es un desplegable propio (no un `<select>` nativo)
porque cada modelo necesita su propio botón de refresco. Tiene **dos bloques**,
y dentro de cada uno se mantiene la agrupación por empresa (proveedor):

1. **Arriba**, bajo «Disponibles»: los modelos que funcionan o están sin cuota.
2. **Debajo**, bajo «No funcionan»: los rotos y los que están sin confirmar.

Cada fila lleva el **icono de estado a la izquierda** (🟢 / 🟡 / 🔴 / ⚪), el
nombre, el aviso correspondiente («sin cuota», «sin esfuerzo»…) y un botón
**⟳** que vuelve a comprobar **sólo ese modelo** y gira mientras trabaja.
Pinchar en el resto de la fila elige ese modelo.

### El esfuerzo no es universal

DSH publica la opción `reasoning_effort` **solo para los modelos que la
admiten**. Jarvis respeta eso: no envía el parámetro a un modelo que no lo
soporta (hacerlo hace fallar el turno) y **oculta el selector de esfuerzo**
cuando el modelo elegido no lo admite.

### Sección de administración

El botón **⚙ Admin** de la barra superior abre el panel de modelos: muestra el
estado de cada uno y el motivo del fallo. El botón **«⟳ Restablecer y comprobar»**
borra el registro aprendido y vuelve a probar **todos** los modelos, de uno en
uno y en segundo plano. La comprobación consume algo de cuota, así que no se
lanza sola.

### Auto-refresco tras una actualización

La interfaz compara la versión que tiene cargada con la que ejecuta el proceso
(`/api/system/status`). Si cambia —porque el actualizador reinició
`jarvis.service`— se recarga sola para no quedarse con la interfaz vieja.

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
| `GET` | `/api/projects/:id/chat/config` | Catálogo de modelos y selección |
| `POST` | `/api/projects/:id/chat/config` | Cambia modelo o esfuerzo |
| `POST` | `/api/projects/:id/chat/reset` | Empieza conversación nueva |
| `GET` | `/api/projects/:id/chat/stream` | Server-Sent Events |
| `GET` | `/api/models/health` | Salud de los modelos (Admin) |
| `POST` | `/api/models/refresh` | Restablece y re-comprueba → `202` |

## Configuración

| Variable | Por defecto | Descripción |
|---|---|---|
| `JARVIS_CHAT_PROTOCOL` | `acp` | `acp` o `sdk`. |
| `JARVIS_CHAT_PROFILE` | `acp` | Perfil de DSH para el chat. |
| `JARVIS_CHAT_PROVIDER` | `deepseek-official` | Proveedor del modelo. |
| `JARVIS_CHAT_MODEL` | `deepseek-v4-flash` | Modelo. |
| `JARVIS_CHAT_EFFORT` | `high` | Esfuerzo de razonamiento. |
| `JARVIS_CHAT_IDLE_MS` | `900000` | Inactividad antes de dormir el proceso. |
| `JARVIS_PERMISSION_TIMEOUT_MS` | `120000` | Tope para contestar un permiso. |
| `JARVIS_STALL_TIMEOUT_MS` | `600000` | Aviso si un turno lleva mucho sin emitir. |
| `JARVIS_MODEL_PROBE_TIMEOUT_MS` | `45000` | Tope por modelo en la comprobación de Admin. |

Al dormirse, el proceso se cierra por EOF de stdin (cierre limpio de ACP) y las
sesiones quedan persistidas para reanudarse al siguiente mensaje.

## Pruebas

`test/infrastructure/acp.test.js` levanta un **servidor ACP falso**
(`test/helpers/fake-acp-server.js`) que habla el protocolo real: manda el texto
en trozos, emite el ciclo de vida de las herramientas y —lo más importante—
**pide permisos y espera respuesta**, que es donde un cliente mal hecho se
bloquea. Se prueba sin gastar tokens ni necesitar red.
