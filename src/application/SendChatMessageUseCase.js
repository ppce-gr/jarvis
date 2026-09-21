/**
 * Capa de Aplicación: SendChatMessageUseCase
 * Envía un mensaje del usuario a la conversación de un proyecto.
 * Devuelve el acuse; la respuesta llega por eventos (el chat es asíncrono).
 */
export class SendChatMessageUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(projectId, text) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    if (!text || !String(text).trim()) throw new Error('MESSAGE_REQUIRED');
    return await this.conversationAdapter.send(projectId, String(text).trim());
  }
}
