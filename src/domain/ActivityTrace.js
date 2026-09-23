/**
 * Dominio: ActivityTrace
 * ==================================================================
 * Reglas puras para convertir lo que hace el agente (herramientas y
 * razonamiento) en una traza legible, guardable y sin secretos.
 *
 * No conoce Node, ni HTTP, ni el disco. Aquí sólo se decide:
 *   - qué texto se resume en una línea,
 *   - qué se recorta (6 KB / 200 líneas por entrada),
 *   - qué se redacta (tokens, claves, contraseñas).
 *
 * La traza vive en el transcript de la conversación (`conversacion.jsonl`),
 * así que sobrevive a recargas y se puede desplegar desde la interfaz.
 */

export const ACTIVITY_LIMITS = Object.freeze({
  maxBytes: 6 * 1024,
  maxLines: 200
});

/** TextEncoder es un global estándar (navegador y Node), no una API de Node. */
const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const byteLength = (text) => (encoder ? encoder.encode(text).length : String(text).length);

/**
 * Patrones de secretos que no deben acabar en el transcript. Se redactan
 * completo (sin conservar prefijos reconocibles) salvo `Bearer`, donde se
 * mantiene la palabra para que se entienda que había un token.
 */
const SECRET_PATTERNS = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: '[CLAVE PRIVADA REDACTADA]'
  },
  { re: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{16,}\b/g, to: '[REDACTADO]' },
  {
    re: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}\b/g,
    to: '[REDACTADO]'
  },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, to: '[REDACTADO]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, to: '[REDACTADO]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: '[REDACTADO]' },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    to: '[REDACTADO]'
  },
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/g, to: '$1 [REDACTADO]' },
  {
    re: /([?&](?:api[_-]?key|access[_-]?token|token|key|secret)=)[^&\s"']+/gi,
    to: '$1[REDACTADO]'
  },
  {
    re: /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|contraseña|token)\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    to: '$1[REDACTADO]'
  },
  { re: /(https?:\/\/[^:@/\s]+:)[^@\s/]+@/g, to: '$1[REDACTADO]@' }
];

/** Tapa los patrones de secreto que aparezcan en un texto. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const { re, to } of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/**
 * Recorta un texto a un máximo de líneas y de bytes UTF-8.
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateText(text, {
  maxBytes = ACTIVITY_LIMITS.maxBytes,
  maxLines = ACTIVITY_LIMITS.maxLines
} = {}) {
  let out = String(text ?? '');
  let truncated = false;

  const lines = out.split('\n');
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }

  if (byteLength(out) > maxBytes) {
    // Búsqueda binaria del mayor prefijo que cabe en bytes.
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (byteLength(out.slice(0, mid)) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    out = out.slice(0, lo);
    // No cortar un par subrogado por la mitad.
    if (out.length && /[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
    truncated = true;
  }

  return { text: out, truncated };
}

/** Texto listo para guardar: redactado, recortado y con aviso de recorte. */
export function sanitizeActivity(text, limits) {
  const redactado = redactSecrets(text);
  const { text: recortado, truncated } = truncateText(redactado, limits);
  return truncated ? `${recortado}\n… [recortado]` : recortado;
}

/** Comprime un texto a una sola línea de como mucho `max` caracteres. */
function oneLine(text, max = 80) {
  const limpio = String(text ?? '').replace(/\s+/g, ' ').trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
}

/** Campos de una herramienta que mejor resumen qué se va a hacer. */
const CAMPOS_RESUMEN = [
  'command', 'cmd', 'path', 'file_path', 'filePath', 'file',
  'pattern', 'query', 'url', 'name', 'prompt', 'instruction'
];

/** Resume la entrada de una herramienta en una línea. */
export function summarizeToolInput(rawInput) {
  if (rawInput === null || rawInput === undefined) return '';
  if (typeof rawInput === 'string') return oneLine(rawInput);
  if (typeof rawInput !== 'object') return oneLine(String(rawInput));
  for (const campo of CAMPOS_RESUMEN) {
    const valor = rawInput[campo];
    if (typeof valor === 'string' && valor.trim()) return oneLine(valor);
  }
  try { return oneLine(JSON.stringify(rawInput)); } catch { return ''; }
}

/** Línea compacta de una herramienta: `nombre · resumen de la entrada`. */
export function summarizeTool(name, rawInput) {
  const resumen = summarizeToolInput(rawInput);
  return resumen ? `${name} · ${resumen}` : String(name || 'herramienta');
}

/** Entrada de la herramienta como texto legible. */
export function formatToolInput(rawInput) {
  if (rawInput === null || rawInput === undefined || rawInput === '') return '';
  if (typeof rawInput === 'string') return rawInput;
  try { return JSON.stringify(rawInput, null, 2); } catch { return String(rawInput); }
}

/** Cuerpo desplegable de una herramienta: entrada y salida. */
export function formatToolDetail(input, output) {
  const bloques = [];
  if (input) bloques.push(`Entrada:\n${input}`);
  if (output) bloques.push(`Salida:\n${output}`);
  return bloques.join('\n\n');
}
