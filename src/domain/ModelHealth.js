/**
 * Dominio: ModelHealth
 * ==================================================================
 * Reglas puras sobre la salud de los modelos que publica el motor de
 * chat. No sabe nada de Node, ni de HTTP, ni del disco: sólo clasifica
 * mensajes de error y filtra catálogos. Así se puede probar sin red y
 * sin gastar cuota.
 *
 * LA IDEA
 *   Al configurar una API key, el motor descubre muchos modelos y no
 *   todos valen. Aquí se decide cuáles se pueden quitar de la lista y
 *   cuáles no:
 *
 *     - `quota`   → se agotó la cuota de la cuenta. NO se quita: puede
 *                   volver a funcionar más adelante.
 *     - `broken`  → el modelo no existe, no está disponible o no es
 *                   accesible. SÍ se quita: reintentarlo no arregla nada.
 *     - `unknown` → fallo transitorio (red, límite temporal, credencial
 *                   mal configurada). NO se quita: la culpa no es del
 *                   modelo.
 *     - `ok`      → funciona (o sólo le falta el soporte de esfuerzo).
 */

export const MODEL_STATUS = Object.freeze({
  OK: 'ok',
  QUOTA: 'quota',
  BROKEN: 'broken',
  UNKNOWN: 'unknown'
});

/**
 * Cuota agotada de verdad (no un límite temporal de peticiones).
 * Los patrones imitan a los del propio DSH (`isQuotaExceededError`) y
 * añaden el vocabulario de los proveedores OpenAI-compatibles y Google.
 */
const QUOTA_PATTERNS = [
  /\binsufficient[\s_-]+(?:quota|balance|credits?|funds?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i,
  /\b(?:balance|credits?|funds?)(?:[\s_-]+is)?[\s_-]+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget|funds?)\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\bpayment[\s_-]+required\b/i,
  /\b402\b/
];

/** El modelo funciona; lo que no admite es el parámetro de esfuerzo. */
const EFFORT_PATTERNS = [
  /UNSUPPORTED_REASONING_EFFORT/i,
  /does not support reasoning effort/i,
  /unknown reasoning effort/i,
  /reasoning effort[\s\S]{0,40}(?:not supported|unsupported|unknown)/i
];

/**
 * Fallos que NO son culpa del modelo: credencial, red, límite temporal
 * o contexto. Si se confundieran con «modelo roto» se borraría la lista
 * entera cuando, por ejemplo, la API key fuese inválida.
 */
const TRANSIENT_PATTERNS = [
  /invalid[\s_-]*(?:api[\s_-]*)?(?:key|credential|token)/i,
  /\b(?:unauthorized|forbidden|authentication|permission denied)\b/i,
  /\b(?:401|403)\b/,
  /rate[\s_-]*limit/i,
  /too[\s_-]*many[\s_-]*requests/i,
  /\b429\b/,
  /\b(?:timeout|timed out|ETIMEDOUT)\b/i,
  /(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)/,
  /\b(?:fetch failed|network|socket hang up|upstream)\b/i,
  /\bcontext[\s_-]+(?:length|window)\b/i,
  /\btoo[\s_-]+(?:long|large)[\s_-]+for\b/i,
  /\bmaximum[\s_-]+context\b/i,
  /\b(?:500|502|503|504)\b/,
  /\b(?:overloaded|service unavailable|internal server error)\b/i
];

/** El modelo en sí no existe o no es utilizable: se puede quitar. */
const UNSUPPORTED_MODEL_PATTERNS = [
  /\bunknown model\b/i,
  /\bmodel[\s_-]+not[\s_-]+found\b/i,
  /\bmodel_not_found\b/i,
  /\bno such model\b/i,
  /\bmodel\b[\s\S]{0,40}\b(?:does not exist|not exist|not available|unavailable|unsupported|decommission(?:ed)?|retired|deprecated|invalid)\b/i,
  /\b(?:do(?:es)?\s+not|don't|doesn't|cannot|can't)\s+(?:have\s+)?access\s+to\s+(?:the\s+)?model\b/i,
  /\bmodel\b[\s\S]{0,40}\bnot\s+(?:supported|accessible|available)\b/i
];

const testAny = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * Clasifica el texto de un fallo del motor.
 * @param {string} message
 * @returns {{status: string, kind: 'quota'|'effort'|'transient'|'unsupported'|'unknown'}}
 */
export function classifyModelFailure(message) {
  const text = String(message ?? '').trim();
  if (!text) return { status: MODEL_STATUS.UNKNOWN, kind: 'unknown' };

  if (testAny(QUOTA_PATTERNS, text)) return { status: MODEL_STATUS.QUOTA, kind: 'quota' };
  // El esfuerzo va ANTES que «modelo no soportado»: el mensaje
  // «... does not support reasoning effort ...» contiene "does not
  // support", que si no se colaría como modelo roto.
  if (testAny(EFFORT_PATTERNS, text)) return { status: MODEL_STATUS.OK, kind: 'effort' };
  if (testAny(TRANSIENT_PATTERNS, text)) return { status: MODEL_STATUS.UNKNOWN, kind: 'transient' };
  if (testAny(UNSUPPORTED_MODEL_PATTERNS, text)) return { status: MODEL_STATUS.BROKEN, kind: 'unsupported' };

  return { status: MODEL_STATUS.UNKNOWN, kind: 'unknown' };
}

/** ¿Este estado justifica retirar el modelo del selector? */
export function isRemovable(status) {
  return status === MODEL_STATUS.BROKEN;
}

/** Busca una opción de configuración por id o por categoría. */
export function findOption(options, id, category) {
  return (options || []).find((o) => o && (o.id === id || (category && o.category === category))) || null;
}

/** La opción de esfuerzo, sólo si el modelo seleccionado la admite. */
export function effortOption(options) {
  return findOption(options, 'reasoning_effort', 'thought_level');
}

/** La opción de modelo con su catálogo de proveedores. */
export function modelOption(options) {
  return findOption(options, 'model', 'model');
}

/** Aplana el catálogo de modelos a una lista de `{value, name, provider}`. */
export function flattenModels(options) {
  const opt = modelOption(options);
  const models = [];
  for (const group of opt?.options || []) {
    for (const item of group?.options || []) {
      if (!item?.value) continue;
      models.push({
        value: item.value,
        name: item.name || item.value,
        provider: group.group || group.name || '',
        description: item.description
      });
    }
  }
  return models;
}

/**
 * Copia del catálogo con cada modelo anotado con su salud, **sin retirar
 * ninguno**. Es lo que necesita el selector para poder enseñar los que
 * funcionan arriba y los que no, debajo.
 */
export function annotateModelHealth(options, results = {}) {
  return (options || []).map((opt) => {
    if (!(opt?.id === 'model' || opt?.category === 'model')) return opt;
    const groups = (opt.options || []).map((group) => {
      const items = (group.options || []).map((item) => {
        const health = results[item.value];
        return {
          ...item,
          health: {
            status: health?.status || MODEL_STATUS.UNKNOWN,
            error: health?.error || null,
            supportsEffort: health?.supportsEffort ?? null
          }
        };
      });
      return { ...group, options: items };
    });
    return { ...opt, options: groups };
  });
}

/**
 * Como `annotateModelHealth`, pero además retira los modelos rotos. Se usa
 * donde no interesa enseñarlos (por ejemplo, para elegir uno sano).
 */
export function applyModelHealth(options, results = {}) {
  return annotateModelHealth(options, results).map((opt) => {
    if (!(opt?.id === 'model' || opt?.category === 'model')) return opt;
    const groups = (opt.options || [])
      .map((group) => ({
        ...group,
        options: group.options.filter((item) => !isRemovable(item.health.status))
      }))
      .filter((group) => group.options.length > 0);
    return { ...opt, options: groups };
  });
}
