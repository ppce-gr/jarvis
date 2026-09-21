/**
 * Capa de Aplicación: ResetChatUseCase
 * Reinicia la conversación de un proyecto: descarta la memoria del agente.
 *
 * El protocolo SDK no ofrece cancelación, así que ésta es la vía para
 * detener un agente descarriado. El historial en disco se conserva.
 */
export class ResetChatUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    return await this.conversationAdapter.reset(projectId);
  }
}
