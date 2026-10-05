/**
 * Capa de Aplicación: ManageConversationsUseCase
 * Archiva, lista, lee y continúa conversaciones de una idea. «Archivar» y
 * «continuar» reinician además la sesión del agente, porque cambia de hilo:
 * al primer mensaje del hilo nuevo se le reinyectan los últimos mensajes.
 */
export class ManageConversationsUseCase {
  constructor(conversationStore, conversationAdapter) {
    this.conversationStore = conversationStore;
    this.conversationAdapter = conversationAdapter;
  }

  async list(projectId) {
    return await this.conversationStore.list(projectId);
  }

  async read(projectId, nombre) {
    return { messages: await this.conversationStore.read(projectId, nombre) };
  }

  /** Guarda la conversación actual y deja el chat limpio (sesión nueva). */
  async archive(projectId) {
    const resultado = await this.conversationStore.archive(projectId);
    await this.conversationAdapter.reset(projectId);
    return resultado;
  }

  /** Trae una conversación archivada como actual y abre sesión nueva. */
  async continue(projectId, nombre) {
    const resultado = await this.conversationStore.restore(projectId, nombre);
    await this.conversationAdapter.reset(projectId);
    return resultado;
  }
}
