/**
 * Puerto de Infraestructura: ConversationPort
 * ------------------------------------------------------------------
 * Contrato del chat conversacional: la "fase conceptual" del sistema,
 * donde el usuario y el agente hablan de una idea antes de ejecutar.
 *
 * Es un puerto DISTINTO de `OrchestratorPort` a propósito:
 *
 *   - OrchestratorPort  → ejecución. Una orden, un resultado, se apaga.
 *                         (dsh --profile headless)
 *   - ConversationPort  → diálogo. Proceso persistente con memoria de
 *                         lo hablado. (dsh --profile sdk)
 *
 * Mezclarlos obligaría a que uno de los dos hiciera mal su trabajo: la
 * conversación necesita memoria y el proceso vivo; la ejecución necesita
 * aislamiento y morir al terminar.
 *
 * El progreso es por eventos: el adaptador empuja lo que va ocurriendo
 * (mensajes, llamadas a herramientas, fin de turno) y quien escuche decide
 * qué hacer con ello. Así la interfaz puede pintarlo en vivo sin que el
 * puerto sepa que existe HTTP.
 */
export class ConversationPort {
  /**
   * Envía un mensaje del usuario a la conversación de un proyecto.
   * Debe arrancar la sesión si no existe.
   * @returns {Promise<{messageId: string, sessionId: string}>}
   */
  async send(projectId, text) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Historial persistido de la conversación (sobrevive a reinicios).
   * @returns {Promise<Array<{role: string, text: string, at: string, kind?: string}>>}
   */
  async history(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Suscribe un observador a los eventos de la conversación.
   * @param {string} projectId
   * @param {(event: object) => void} listener
   * @returns {() => void} función para cancelar la suscripción
   */
  subscribe(projectId, listener) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Estado actual de la conversación de un proyecto.
   * @returns {Promise<{sessionId: string|null, status: string, busy: boolean}>}
   */
  async status(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Detiene el turno en curso conservando la memoria del agente.
   * Los adaptadores cuyo protocolo no sepa cancelar devolverán
   * `{ cancelled: false }` sin lanzar.
   * @returns {Promise<{cancelled: boolean}>}
   */
  async cancel(projectId) {
    return { cancelled: false };
  }

  /**
   * Reinicia la conversación: descarta la memoria del agente.
   * El historial en disco se conserva.
   */
  async reset(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /** Cierra todas las sesiones y libera los procesos. */
  async closeAll() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
