/**
 * Capa de Aplicación: BrowseProjectFilesUseCase
 * Permite a la interfaz listar y leer los ficheros de las zonas `code/`
 * y `logs/` de un proyecto, manteniendo la vista conceptual limpia.
 */
export class BrowseProjectFilesUseCase {
  constructor(fileBrowserAdapter) {
    this.fileBrowserAdapter = fileBrowserAdapter;
  }

  async list(projectId, zone = 'code') {
    return await this.fileBrowserAdapter.listFiles(projectId, zone);
  }

  async read(projectId, zone, relativePath) {
    return await this.fileBrowserAdapter.readFile(projectId, zone, relativePath);
  }
}
