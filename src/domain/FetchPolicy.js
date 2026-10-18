/**
 * Dominio: FetchPolicy
 * ==================================================================
 * Cómo debe descargar el agente el contenido de una URL. Hay dos modos:
 *
 *   - `script` (por defecto): el agente usa la terminal (`curl`/`wget`) y
 *     trabaja con el fichero local. Es el modo seguro en la Raspberry Pi 3B:
 *     no carga la página en el contexto del modelo ni dispara herramientas
 *     de navegación que puedan agotar la memoria.
 *   - `ia`: la URL se le pasa a la herramienta de fetch del modelo.
 *
 * La configuración vive en `chat-config.json` (`fetch_mode`) y, como
 * respaldo, en la variable de entorno `JARVIS_FETCH_MODE`. El valor por
 * defecto es SIEMPRE `script`: si algo falta o es inválido, se descarga con
 * scripts, nunca se arriesga a tumbar la máquina.
 */

export const FETCH_MODES = Object.freeze(['script', 'ia']);
export const DEFAULT_FETCH_MODE = 'script';

/** Normaliza el modo; cualquier cosa rara cae al valor seguro. */
export function normalizarFetchMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'ia' || v === 'ai' || v === 'modelo' || v === 'model') return 'ia';
  return DEFAULT_FETCH_MODE;
}

/**
 * Líneas que se inyectan en el enunciado del agente para que sepa qué hacer
 * cuando tenga que descargar una URL.
 * @param {string} mode `script` | `ia`
 * @returns {string[]}
 */
export function fetchPolicyLines(mode) {
  if (normalizarFetchMode(mode) === 'ia') {
    return [
      'Descargas y Fetch de URLs:',
      '- Puedes pasar la URL a la herramienta de fetch de la IA.',
      '- Si la descarga es grande o binaria, usa `curl`/`wget` y trabaja con el fichero local.'
    ];
  }
  return [
    'Descargas y Fetch de URLs (modo SEGURO para esta Raspberry):',
    '- NO uses la herramienta de fetch/navegación de la IA: en esta máquina puede agotar la memoria y tumbarla.',
    '- Descarga siempre con la terminal: `curl -fsSL --max-time 120 -o <destino> <url>` o `wget -q -O <destino> <url>`.',
    '- Comprueba el código de salida y que el fichero no esté vacío; después lee el fichero local.'
  ];
}
