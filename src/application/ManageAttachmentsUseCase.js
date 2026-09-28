/**
 * Capa de Aplicación: ManageAttachmentsUseCase
 * Gestiona los ficheros que el usuario adjunta a una idea: listarlos,
 * subirlos, moverlos a su sitio, desasociarlos sin borrarlos o borrarlos.
 */
export class ManageAttachmentsUseCase {
  constructor(attachmentAdapter) {
    this.attachmentAdapter = attachmentAdapter;
  }

  async list(projectId) {
    return await this.attachmentAdapter.list(projectId);
  }

  async save(projectId, nombre, contenido) {
    return await this.attachmentAdapter.save(projectId, nombre, contenido);
  }

  async move(projectId, nombre, destino) {
    return await this.attachmentAdapter.move(projectId, nombre, destino);
  }

  async detach(projectId, nombre) {
    return await this.attachmentAdapter.detach(projectId, nombre);
  }

  async remove(projectId, nombre) {
    return await this.attachmentAdapter.remove(projectId, nombre);
  }
}
