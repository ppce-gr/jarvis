/**
 * Capa de Aplicación: SetChatConfigUseCase
 * Cambia el modelo o el esfuerzo de razonamiento del chat y lo persiste.
 */
export class SetChatConfigUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(configId, value) {
    if (!configId) throw new Error('CONFIG_ID_REQUIRED');
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error('CONFIG_VALUE_REQUIRED');
    }
    return await this.conversationAdapter.setConfig(String(configId), String(value));
  }
}
