/**
 * Dominio: ConversationCompaction
 * ==================================================================
 * Una conversación puede crecer sin límite porque el transcript guarda
 * **todo** lo que ocurre: mensajes, pero también la traza de cada herramienta
 * (salidas de `bash`, lecturas de ficheros…) y el razonamiento. En la Pi eso
 * acaba pesando varios MB y, con el tope de lectura, la conversación deja de
 * verse.
 *
 * La compactación conserva lo que hace falta para que la conversación siga
 * siendo coherente:
 *   - **Todas** las marcas `subchat`: son los resúmenes de los chats, el
 *     contexto de la conversación.
 *   - El **texto** (mensajes de usuario y de Jarvis), hasta un máximo de los
 *     más antiguos; el resto se resume en las marcas.
 *   - El **chat actual** (desde la última marca) **entero**, con su traza, que
 *     es lo que el usuario está viendo ahora.
 *   - De los chats anteriores se descarta la **traza** (tool/thought), que es
 *     la que infla el fichero.
 *
 * Así el fichero se mantiene pequeño sin perder el hilo ni los resúmenes.
 */

export const COMPACTION_TRIGGER_BYTES = 2 * 1024 * 1024;
export const MAX_TEXTO_ANTIGUO = 300;

const ROLES_TEXTO = new Set(['user', 'assistant']);
const ROLES_CONTEXTO = new Set(['subchat']);

/**
 * Devuelve la lista compactada (no muta la original).
 * @param {Array<object>} mensajes
 * @returns {Array<object>}
 */
export function compactarConversacion(mensajes = []) {
  const lista = Array.isArray(mensajes) ? mensajes : [];

  let ultimo = -1;
  for (let i = 0; i < lista.length; i += 1) {
    if (lista[i]?.role === 'subchat') ultimo = i;
  }

  // Sin marcas todavía: no hay nada seguro que descartar (el chat actual es
  // todo el hilo). Se deja como está y la lectura por cola cubre el tamaño.
  if (ultimo < 0) return lista.slice();

  const previos = lista.slice(0, ultimo);
  const actual = lista.slice(ultimo);

  // De los chats anteriores: contexto (resúmenes) y texto; fuera la traza.
  let antiguos = previos.filter((m) => ROLES_CONTEXTO.has(m.role) || ROLES_TEXTO.has(m.role));

  // Si aún hay demasiado texto antiguo, se conservan los últimos mensajes.
  const texto = antiguos.filter((m) => ROLES_TEXTO.has(m.role));
  if (texto.length > MAX_TEXTO_ANTIGUO) {
    const sobran = texto.length - MAX_TEXTO_ANTIGUO;
    let quitados = 0;
    antiguos = antiguos.filter((m) => {
      if (ROLES_TEXTO.has(m.role) && quitados < sobran) {
        quitados += 1;
        return false;
      }
      return true;
    });
  }

  return [...antiguos, ...actual];
}
