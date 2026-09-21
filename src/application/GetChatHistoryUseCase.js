/**
 * Capa de Aplicación: GetChatHistoryUseCase
 * Devuelve lo hablado en un proyecto más el estado de la sesión.
 *
 * El historial se lee del disco, así que sobrevive a reinicios de Jarvis
 * aunque la memoria del agente (que vive en el proceso de DSH) no.
 */
export class GetChatHistoryUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const [messages, status] = await Promise.all([
      this.conversationAdapter.history(projectId),
      this.conversationAdapter.status(projectId)
    ]);
    return { messages, status };
  }
}
