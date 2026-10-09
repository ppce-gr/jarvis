/**
 * Capa de Aplicación: ManageConversationsUseCase
 * Archiva, lista, lee y continúa conversaciones de una idea. «Archivar» y
 * «continuar» reinician además la sesión del agente, porque cambia de hilo:
 * al primer mensaje del hilo nuevo se le reinyectan los últimos mensajes.
 * También pone título y gestiona la papelera de conversaciones.
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

  async setTitle(projectId, nombre, titulo) {
    return { conversation: await this.conversationStore.setTitle(projectId, nombre, titulo) };
  }

  /** Manda una guardada a la papelera. No toca la conversación actual. */
  async remove(projectId, nombre) {
    return { conversation: await this.conversationStore.remove(projectId, nombre) };
  }

  async listTrash(projectId) {
    return { items: await this.conversationStore.listTrash(projectId) };
  }

  async restoreTrash(projectId, ref) {
    return { conversation: await this.conversationStore.restoreTrash(projectId, ref) };
  }

  async purgeTrash(projectId, ref) {
    return { conversation: await this.conversationStore.purgeTrash(projectId, ref) };
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
