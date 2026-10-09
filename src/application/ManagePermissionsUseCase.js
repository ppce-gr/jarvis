/**
 * Capa de Aplicación: ManagePermissionsUseCase
 * El agente pide una acción privilegiada; el usuario la aprueba una a una con
 * su PIN; un helper de root la ejecuta. Aquí solo se orquesta.
 */
export class ManagePermissionsUseCase {
  constructor(permissionAdapter) {
    this.permissionAdapter = permissionAdapter;
  }

  async list(projectId) {
    return await this.permissionAdapter.list(projectId);
  }

  async request(projectId, comando, motivo = '', cwd = '') {
    return await this.permissionAdapter.request(projectId, comando, motivo, cwd);
  }

  async approve(projectId, id, pin) {
    return await this.permissionAdapter.approve(projectId, id, pin);
  }

  async reject(projectId, id, motivo = '') {
    return await this.permissionAdapter.reject(projectId, id, motivo);
  }
}
