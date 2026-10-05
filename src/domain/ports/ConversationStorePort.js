/**
 * Puerto: ConversationStorePort
 * Guarda y recupera conversaciones de una idea: archivar la actual, listarlas,
 * leerlas y traer una archivada de vuelta para continuarla.
 */
export class ConversationStorePort {
  async list(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async read(projectId, nombre) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async archive(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async restore(projectId, nombre) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
}
