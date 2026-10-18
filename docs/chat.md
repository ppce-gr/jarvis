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

### Traza de actividad: qué está haciendo el agente

Para no perderse mientras trabaja, el chat muestra una **traza** de lo que
hace, sin ensuciar la conversación:

- **Herramientas**: una línea compacta y discreta por herramienta
  (`✓ read_file · nota.md`), con una flecha para **desplegar** la entrada y la
  salida completas. Se actualiza en el sitio cuando termina (`✓`) o falla (`✗`).
- **Razonamiento**: al cerrar el turno se añade un bloque **🧠 Razonamiento**,
  también plegado, con lo que el agente pensó.

La traza se guarda en el transcript (`conversacion.jsonl`), así que **sobrevive
a las recargas**; al volver, todo aparece **plegado**. El detalle se **recorta a
6 KB / 200 líneas** por entrada y se **redactan los patrones de secreto** típicos
(tokens, claves, contraseñas) antes de guardarlo. Funciona igual con los dos
protocolos, **ACP y SDK**.

### Detener con confirmación

Mientras el agente trabaja, el campo de escritura se deshabilita y el botón
**Enviar** se convierte en **■ Detener**. También sigue el botón **Detener** de
la cabecera. Pulsar cualquiera de los dos **pide confirmación** antes de
cancelar el turno.

### Conversaciones y chats

Conviene separar dos conceptos, porque la interfaz los muestra como cosas distintas:

- Una **conversación** es un **tema** dentro de una idea. Puedes tener varias: al
  pulsar **＋ Conversación** la actual se guarda y empieza una limpia.
- Un **chat** es un **tramo** de una conversación. Es Jarvis quien los crea solo:
  cuando el hilo se alarga, lo **parte en chats** pidiendo al agente un **resumen**
  con un turno oculto, abre una **sesión nueva** sembrada con ese resumen y sigue
  como si nada.

El usuario **no nota el corte**: ve el mismo chat, con una **marca** entre tramos
(«Chat 2 · resumen del anterior», con el resumen desplegable) y un **contador** en
la cabecera («2 chats»). En **🗂 Conversaciones** cada conversación dice **cuántos
chats** la componen y, al desplegarla, lista cada chat con su resumen.

El umbral se mide por **tokens estimados** (~4 caracteres por token) y por
**tamaño del texto**, y es configurable:

| Variable | Por defecto |
|---|---|
| `JARVIS_CHAT_MAX_TOKENS` | `30000` |
| `JARVIS_CHAT_MAX_BYTES` | `80000` |

Al **continuar** una conversación guardada también se abre un chat nuevo con
resumen, en vez de reinyectar solo los 20 últimos mensajes.

### Tamaño de la conversación

El transcript guarda el texto y también la **traza** de cada herramienta (salidas
de `bash`, lecturas de ficheros, razonamiento). En una conversación larga eso pesa
mucho más que la propia conversación. Para que nunca deje de verse:

- Cuando el fichero supera **2 MB**, se **compacta** automáticamente: se conservan
  **todos los resúmenes de los chats** (marcas `subchat`) y el **texto** de
  usuario/Jarvis; se descarta la **traza antigua** (`tool`/`thought`). El **chat
  actual** se conserva entero, con su traza.
- Si aún queda demasiado texto antiguo, se conservan los últimos **300** mensajes
  de texto; los anteriores siguen representados por los resúmenes de sus chats.
- Red de seguridad: si un fichero ya supera los **4 MB**, la lectura devuelve la
  **cola** (las últimas líneas) en vez de vacío, así la conversación sigue
  apareciendo y se puede continuar. En la lista se marca como **«recortada»**.

La compactación no toca la sesión viva del agente: el hilo sigue siendo coherente
porque los resúmenes de los chats son el contexto.

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
| `JARVIS_CHAT_MAX_TOKENS` | `30000` | Umbral de tokens para partir en sub-chat. |
| `JARVIS_CHAT_MAX_BYTES` | `80000` | Umbral de bytes para partir en sub-chat. |
| `JARVIS_FETCH_MODE` | `script` | Descargas de URLs: `script` (curl/wget) o `ia` (fetch del modelo). |
| `JARVIS_PERMISSION_TIMEOUT_MS` | `120000` | Tope para contestar un permiso. |
| `JARVIS_STALL_TIMEOUT_MS` | `600000` | Aviso si un turno lleva mucho sin emitir. |
| `JARVIS_MODEL_PROBE_TIMEOUT_MS` | `45000` | Tope por modelo en la comprobación de Admin. |

Los umbrales de sub-chat se cablean en el despliegue (`deploy/jarvis.conf.example`
y la unidad que genera `deploy/instalar.sh`), así que se ajustan sin tocar código.
Los sub-chats funcionan con los **dos** protocolos: `acp` (por defecto) y `sdk`.

### Descargas y Fetch de URLs

Cuando el agente tiene que traer el contenido de una URL hay dos modos. Se
eligen en **⚙ Admin → pestaña Descargas** (es un ajuste de **toda la
aplicación**, no de un chat concreto) o en `chat-config.json` (`fetch_mode`):

- **`script` (por defecto)**: el agente **no** usa la herramienta de fetch del
  modelo; descarga con `curl`/`wget` a un fichero y lee el fichero local. Es el
  modo seguro en la Raspberry Pi 3B, donde el fetch del modelo puede agotar la
  memoria y tumbar la máquina.
- **`ia`**: la URL se le pasa a la herramienta de fetch del modelo.

El valor por defecto es siempre `script`: si falta o es inválido, se descarga
con scripts. El modo se inyecta en el enunciado del agente (chat ACP, chat SDK y
tareas del orquestador) al abrir sesión.

El panel **⚙ Admin** se organiza en tres pestañas —**Modelos**, **Servicios** y
**Descargas**— para no amontonar ajustes. El modo de descargas se lee con
`GET /api/config` y se guarda con `POST /api/config`; ninguna de las dos rutas
necesita una idea abierta, porque es configuración de la aplicación.

Al dormirse, el proceso se cierra por EOF de stdin (cierre limpio de ACP) y las
sesiones quedan persistidas para reanudarse al siguiente mensaje.

## Pruebas

`test/infrastructure/acp.test.js` levanta un **servidor ACP falso**
(`test/helpers/fake-acp-server.js`) que habla el protocolo real: manda el texto
en trozos, emite el ciclo de vida de las herramientas y —lo más importante—
**pide permisos y espera respuesta**, que es donde un cliente mal hecho se
bloquea. Se prueba sin gastar tokens ni necesitar red.
