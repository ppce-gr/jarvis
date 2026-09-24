# Proveedores y modelos

Jarvis no incluye modelos: se los pide a **DeepSeek Harness (DSH)**. DSH soporta
muchos proveedores a través del plugin `llm-pi-ai`, y cada uno se configura con
**dos piezas**:

1. un **perfil de proveedor** en `~/.dsh/settings.yaml`, bajo
   `llm-pi-ai.providers.<ruta>`;
2. su **clave de API** en `~/.dsh/.credentials.yaml` (o en una variable de
   entorno).

DSH **vigila** los dos ficheros y aplica los cambios **en caliente**: no hace
falta reiniciar el servicio.

> La ruta `~/.dsh` es la de DSH (`$DSH_HOME`). Si instalaste DSH en otro sitio,
> ajusta la ruta. Son ficheros **fuera del repositorio**: las claves nunca van a
> Git.

## Proveedores que DSH ya conoce

Para estos basta con `apiKeyEnv`: los modelos se toman del catálogo que ya trae
DSH.

```text
amazon-bedrock, ant-ling, anthropic, azure-openai-responses, baseten, cerebras,
cloudflare-ai-gateway, cloudflare-workers-ai, deepseek, fireworks, github-copilot,
google, google-vertex, groq, huggingface, kimi-coding, minimax, minimax-cn,
mistral, moonshotai, moonshotai-cn, nvidia, openai, openai-codex, opencode,
opencode-go, openrouter, qwen-token-plan, qwen-token-plan-cn,
qwen-token-plan-individual, together, vercel-ai-gateway, xai, xiaomi,
xiaomi-token-plan-ams, xiaomi-token-plan-cn, xiaomi-token-plan-sgp, zai,
zai-coding-cn
```

### Ejemplo: Claude (Anthropic)

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
```

```yaml
# ~/.dsh/.credentials.yaml   (permisos 600)
version: 1
refs:
  ANTHROPIC_API_KEY: "sk-ant-..."
```

Otros: `openai` (`OPENAI_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`),
`groq` (`GROQ_API_KEY`). **Google/Gemini** (`google`) ya viene declarado en la
instalación de ejemplo; solo necesita su clave en `refs.GOOGLE_API_KEY`.

## Un endpoint compatible no listado

Si el proveedor no está en la lista de arriba (Ollama, vLLM, un proxy propio…),
hay que declarar el protocolo (`api`), la `baseURL` y los `models`:

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    mi-endpoint:
      apiKeyEnv: MI_ENDPOINT_API_KEY
      displayName: Mi endpoint
      api: openai-completions
      baseURL: http://192.168.1.50:11434/v1
      models:
        - id: llama3.1:8b
          name: Llama 3.1 8b
          contextWindow: 131072
          maxTokens: 8192
```

Los únicos protocolos que sirve esta versión de DSH son:

- `openai-completions` (el más común en endpoints compatibles),
- `openai-responses`,
- `anthropic-messages`.

## Usar variables de entorno en vez del fichero

Si prefieres no tocar `.credentials.yaml`, exporta la variable **antes de
arrancar** el servicio:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Con systemd, eso se hace con `Environment=` o `EnvironmentFile=` en la unidad
(fuera del repositorio).

## Aplicar los cambios

1. Guarda `settings.yaml` y `.credentials.yaml` (este último con `chmod 600`).
2. En Jarvis, abre **⚙ Admin → «Restablecer y comprobar»** para releer el
   catálogo. Los modelos del proveedor nuevo aparecerán agrupados por empresa.
3. Si un modelo aparece pero falla, el registro de salud de Jarvis lo marcará
   como «sin cuota» (se conserva) o «no funciona» (se baja al bloque de abajo).

## Seguridad

- **Nunca** subas claves al repositorio: es **público**. Viven en
  `~/.dsh/.credentials.yaml` o en variables de entorno.
- `.credentials.yaml` debe ser **solo para su dueño** (`chmod 600`). DSH se
  niega a arrancar si tiene permisos más abiertos.
- El transcript de las conversaciones puede contener texto de herramientas;
  Jarvis recorta el detalle y redacta patrones de secreto antes de guardarlo,
  pero la clave de API no debe pasar por el chat.

## Si algo no aparece

- Revisa la **sintaxis YAML** (DSH valida en estricto) y los permisos `600`.
- Mira el registro: `journalctl -u jarvis -n 50` (o el log de DSH).
- Comprueba que el nombre de la ruta del proveedor está en la lista de arriba
  si no declaras `models`.
- Recuerda que la cuota y el saldo son del proveedor: un modelo válido puede
  aparecer «sin cuota» hasta que se restablezca.
