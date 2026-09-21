/**
 * Capa de Aplicación: SubscribeChatUseCase
 * Conecta un observador a los eventos de la conversación de un proyecto.
 *
 * Existe para que la capa HTTP pueda emitir Server-Sent Events sin conocer
 * al adaptador de conversación: sigue hablando sólo con casos de uso.
 */
export class SubscribeChatUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  /**
   * @param {string} projectId
   * @param {(event: object) => void} listener
   * @returns {() => void} cancelar la suscripción
   */
  execute(projectId, listener) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    return this.conversationAdapter.subscribe(projectId, listener);
  }
}
