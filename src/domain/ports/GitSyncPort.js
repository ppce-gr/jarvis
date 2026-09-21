/**
 * Puerto de Infraestructura: GitSyncPort
 * Contrato abstracto para el respaldo y sincronización con Git.
 * El dominio no sabe si por debajo hay GitHub, GitLab o un Gitea local.
 */
export class GitSyncPort {
  async status() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async commitAll(message) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async push() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
