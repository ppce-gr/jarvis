# Integración con DeepSeek Harness

Este documento registra **qué vías ofrece DSH para ser controlado por un
programa externo**, las mediciones hechas en la Raspberry Pi 3B real, y la
decisión tomada. Es la justificación de por qué `DshHeadlessOrchestratorAdapter`
es como es.

---

## 1. Las vías que expone DSH (inspeccionadas en la instalación real)

El CLI `dsh` documenta explícitamente sus modos de entrada:

| Comando | Qué es |
|---|---|
| `dsh --profile headless "tarea"` | Una tarea, imprime la respuesta final y sale. No abre puertos. |
| `dsh --profile sdk` | Servidor JSON-RPC por stdio para clientes SDK (proceso persistente). |
| `dsh --profile sdk-minimal` | Igual, con árbol de plugins mínimo y sin `dsh-base`. |
| `dsh --profile acp` | Servidor del **Agent Client Protocol** por stdio (estándar de editores). |
| `dsh web` | La interfaz web (es la que ya usas en el puerto 3080). |
| `dsh plugin --profile <n> ...` | Gestión de plugins del perfil (reenvía a pnpm). |

Además existen paquetes que, en teoría, permitirían otras integraciones:

| Paquete | Para qué | ¿Nos sirve? |
|---|---|---|
| `dsh-webhook` | Convertir eventos externos en sesiones de agente | No: requiere montar el runtime de webhooks y un adaptador de proveedor. Es para GitHub, no para órdenes de usuario. |
| `dsh-schedule` | Recordatorios *dentro* de una conversación viva | No: es una herramienta del agente, no un disparador externo. |
| `dsh-mcp-client` | Consumir servidores MCP | No: es para que el agente consuma herramientas, no para controlarlo. |
| `dsh-sdk-protocol` | Tipos y transporte JSON-RPC del SDK | Sí, si algún día vamos a la opción B. |
| `@agentclientprotocol/sdk` | Cliente/servidor ACP estándar | Presente sólo como **devDependency** de `dsh`; frágil de asumir. |

**Descartada por decisión previa:** montar nuestra interfaz como *plugin* dentro
de un perfil custom de DSH. Acoplaría Jarvis a las tripas de DSH y rompería el
principio de independencia que acordamos.

**Descartada por inestable:** llamar a la API HTTP interna del perfil `web`
(puerto 3080). Es la API privada de su propio navegador, sin contrato público,
y cambia entre versiones.

---

## 2. Mediciones reales en la Raspberry Pi 3B

Pruebas ejecutadas en esta máquina con `dsh --profile headless`:

| Métrica | Valor medido |
|---|---|
| Arranque en frío (primera vez, auto-init del perfil) | 16,5 s |
| Arranque en caliente (ejecución típica) | 16–18 s |
| Memoria pico (RSS) | **168 MB** |
| ¿Escribe ficheros sin aprobación humana? | **Sí** (creó `hola.txt` con el contenido exacto) |
| Separación de flujos | Razonamiento → `stderr`, respuesta final → `stdout` |
| Exit code | `0` completado, `1` abortado/error |
| Auto-inicialización del perfil | **Sin red y sin `pnpm install`** (usa `.dsh-module-fallback`) |

Prueba end-to-end completa (orden real desde la interfaz de Jarvis):

```text
Orden:    "Escribe code/resumen.md con una línea que resuma el proyecto"
Duración: 18,5 s
Exit:     0
Efecto:   creó projects/ejemplo-proyecto/code/resumen.md
          leyó antes conceptual/_indice.md y qa-dudas.md   ← contexto respetado
Bitácora: logs/t1-….log + logs/orchestrator.log
```

El dato que manda es **168 MB por tarea**: dos en paralelo (~336 MB) más el
perfil web dejarían la Pi de 1 GB contra las cuerdas. De ahí la **cola de uno**.

---

## 3. Comparativa de las tres vías viables

| Criterio | A) headless | B) SDK stdio | C) ACP stdio |
|---|---|---|---|
| Proceso | Uno nuevo por tarea | Persistente | Persistente |
| Coste de arranque | 16–18 s **por tarea** | Sólo al arrancar | Sólo al arrancar |
| Memoria | 168 MB por tarea | 1 proceso estable | 1 proceso estable |
| Progreso en vivo | Sólo por `stderr` | Eventos estructurados (`session.event`, `subagent.started`) | Actualizaciones ACP tipadas |
| Continuidad de conversación | No (sesión nueva cada vez) | Sí (sesiones) | Sí (list/resume) |
| Código a escribir | ~0 (ya hecho) | Cliente JSON-RPC a mano | Cliente ACP |
| Dependencias nuevas | **Ninguna** | **Ninguna** si usamos `dsh-sdk-protocol` | `@agentclientprotocol/sdk` (hoy devDependency de `dsh`) |
| Estabilidad del contrato | Documentado y estable | Documentado y estable | Estándar externo |
| Riesgo en la Pi 3B | Bajo | Medio (proceso vivo + gestión) | Medio |

---

## 4. Decisión: **A) headless ahora**, y el puerto queda listo para B

Se implementa `DshHeadlessOrchestratorAdapter` porque:

1. **Está verificado funcionando en esta Pi**, no en teoría.
2. **Cero dependencias nuevas**: `spawn` del módulo nativo de Node. Coherente
   con el principio de minimalismo.
3. **Encaja exactamente** en `OrchestratorPort.executeTask(projectId, instruction)`.
4. **No reinventa la rueda**: DSH ya sabe orquestar internamente (tiene sus
   propias herramientas de subagentes y workflows). Nosotros le mandamos **una**
   orden y DSH hace el fan-out por dentro. Nuestro trabajo es registrar y mostrar.
5. Los 16–18 s se pagan **una vez por orden**, no por subagente.

### Cuándo migrar a B (SDK persistente)

Cuando ocurra **cualquiera** de estas cosas:

- El arranque de 16–18 s empiece a molestar en tareas cortas y frecuentes.
- Quieras ver el progreso paso a paso (qué herramienta usa, qué subagente lanza)
  en lugar de un volcado de razonamiento.
- Quieras conversación continua sobre una idea sin repetir contexto.

Entonces se escribe `DshSdkOrchestratorAdapter` hablando JSON-RPC contra
`dsh --profile sdk`, y en `src/index.js` se cambia **una línea**. El dominio, los
casos de uso y la interfaz no se tocan: para eso está la arquitectura hexagonal.

---

## 5. Configuración del adaptador

| Variable de entorno | Por defecto | Descripción |
|---|---|---|
| `JARVIS_DSH_BIN` | `dsh` | Binario de DSH. |
| `JARVIS_DSH_PROFILE` | `headless` | Perfil a usar. |
| `DSH_HOME` | el del entorno | Raíz de perfiles/sesiones de DSH. |
| `JARVIS_TASK_TIMEOUT_MS` | `900000` (15 min) | Tope por tarea; al superarlo se mata y se marca `timeout`. |

### Decisiones de seguridad y robustez

- **El directorio de trabajo del agente es la carpeta del proyecto**, no el
  workspace entero. El agente ve `conceptual/`, escribe en `code/` y no debería
  tocar el resto del repositorio.
- **Tope de 1 MB por bitácora de tarea** (`MAX_LOG_BYTES`): el razonamiento se
  vuelca en vivo para ver progreso sin castigar la tarjeta SD.
- **Cola de uno**: `this._chain` serializa las tareas en todo el proceso. Nunca
  dos agentes a la vez en la Pi.
- **Fallar no rompe nada**: un error del runner se registra como `failed` con su
  exit code; la bitácora general guarda el resumen.

---

## 6. Lo que le pedimos al agente (y por qué)

El enunciado que envía el adaptador es deliberadamente corto:

```text
Trabajas dentro del proyecto "<id>" de Jarvis.
El directorio de trabajo actual ES la carpeta del proyecto.
- Lee el contexto en `conceptual/` antes de actuar (sobre todo `_indice.md` y `qa-dudas.md`).
- Escribe el código y los artefactos en `code/`.
- No modifiques ficheros fuera de este proyecto.

Orden del usuario:
<instrucción>

Al terminar, responde con un resumen breve y concreto de lo que has hecho.
```

No metemos la especificación entera en el prompt: el agente **la lee del disco**.
Así el contexto no se duplica, no se pudre y el usuario puede editarlo con la
interfaz mientras el agente trabaja. Es la misma razón por la que la bitácora
vive en ficheros y no en una base de datos.
