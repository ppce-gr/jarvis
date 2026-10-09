/**
 * Puerto: IdeaManagementPort
 * Contrato para gestionar ideas: duplicar, renombrar, borrar (a papelera),
 * fusionar, y la jerarquía (idea padre) + linaje. Incluye la papelera:
 * listar, restaurar y borrar definitivamente.
 */
export class IdeaManagementPort {
  async meta() { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async setParent(projectId, padre) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async duplicate(projectId, nuevoId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async rename(projectId, nuevoId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async trash(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async merge(origenId, destinoId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async listTrash() { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async restore(ref) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async purge(ref) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
}
