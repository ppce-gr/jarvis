/**
 * Capa de Aplicación: ManageIdeasUseCase
 * Duplicar, renombrar, borrar (a papelera), fusionar ideas, y su jerarquía
 * (padre) + linaje. También la papelera: listar, restaurar y purgar.
 */
export class ManageIdeasUseCase {
  constructor(ideaManagementAdapter) {
    this.ideaManagementAdapter = ideaManagementAdapter;
  }

  async meta() {
    return await this.ideaManagementAdapter.meta();
  }

  async listTrash() {
    return await this.ideaManagementAdapter.listTrash();
  }

  async restore(ref) {
    return await this.ideaManagementAdapter.restore(ref);
  }

  async purge(ref) {
    return await this.ideaManagementAdapter.purge(ref);
  }

  async setParent(projectId, padre) {
    return await this.ideaManagementAdapter.setParent(projectId, padre);
  }

  async duplicate(projectId, nuevoId) {
    return await this.ideaManagementAdapter.duplicate(projectId, nuevoId);
  }

  async rename(projectId, nuevoId) {
    return await this.ideaManagementAdapter.rename(projectId, nuevoId);
  }

  async trash(projectId) {
    return await this.ideaManagementAdapter.trash(projectId);
  }

  async merge(origenId, destinoId) {
    return await this.ideaManagementAdapter.merge(origenId, destinoId);
  }
}
