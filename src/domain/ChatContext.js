/**
 * Dominio: ChatContext
 * ==================================================================
 * Mide cuánto ha crecido una conversación para decidir cuándo partirla en
 * un **sub-chat**: una sesión nueva sembrada con un resumen, de forma que el
 * usuario no note diferencia pero el gasto de tokens se mantenga a raya.
 *
 * No hay tokenizador (cero dependencias): se estima a ~4 caracteres por token
 * y se mide el tamaño real en bytes UTF-8. Son umbrales conservadores: con
 * pasarse, solo se gasta una llamada de resumen; con quedarse corto, el
 * contexto se hace enorme.
 *
 * El dominio no conoce Node: usa `TextEncoder`, que es un estándar web.
 */

export const CHAT_LIMITS = Object.freeze({
  maxTokens: 30000,
  maxBytes: 80000
});

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const bytesDe = (texto) => (encoder ? encoder.encode(String(texto)).length : String(texto).length);

/** Estimación barata de tokens: ~4 caracteres por token. */
export function estimarTokens(texto) {
  const s = String(texto ?? '');
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** Normaliza límites: cualquier valor inválido cae al de por defecto. */
export function normalizarLimites({ maxTokens, maxBytes } = {}) {
  return {
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens) : CHAT_LIMITS.maxTokens,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes) : CHAT_LIMITS.maxBytes
  };
}

/**
 * Mide una conversación (solo cuenta turnos de usuario y de Jarvis; las
 * marcas de sub-chat y la actividad no cuentan) y decide si toca partir.
 * @returns {{tokens: number, bytes: number, mensajes: number, debePartir: boolean}}
 */
export function medirConversacion(mensajes, limites = CHAT_LIMITS) {
  const lim = normalizarLimites(limites);
  let tokens = 0;
  let bytes = 0;
  let mensajesContados = 0;
  for (const m of mensajes || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const texto = String(m.text || '');
    tokens += estimarTokens(texto);
    bytes += bytesDe(texto);
    mensajesContados += 1;
  }
  return {
    tokens,
    bytes,
    mensajes: mensajesContados,
    debePartir: tokens >= lim.maxTokens || bytes >= lim.maxBytes
  };
}
