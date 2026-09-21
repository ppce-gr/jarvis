/**
 * Capa de Aplicación: GetChatConfigUseCase
 * Devuelve el catálogo de modelos y opciones del motor de chat, junto con la
 * selección actual. Es lo que alimenta el selector de la interfaz.
 */
export class GetChatConfigUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(projectId = '') {
    return await this.conversationAdapter.getConfig(projectId);
  }
}
