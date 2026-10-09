/**
 * Puerto: ConversationStorePort
 * Guarda y recupera conversaciones de una idea: archivar la actual, listarlas,
 * leerlas y traer una archivada de vuelta para continuarla. Incluye poner
 * título, mandar una a la papelera y recuperarla o purgarla.
 */
export class ConversationStorePort {
  async list(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async read(projectId, nombre) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async archive(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async restore(projectId, nombre) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async setTitle(projectId, nombre, titulo) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async remove(projectId, nombre) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async listTrash(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async restoreTrash(projectId, ref) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async purgeTrash(projectId, ref) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
}
