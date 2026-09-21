/**
 * Puerto de Infraestructura: FileBrowserPort
 * Contrato para explorar las zonas de un proyecto (code/, logs/) y leer
 * ficheros de solo texto, permitiendo a la interfaz mostrar el resultado
 * del trabajo de los agentes sin exponer todo el sistema de ficheros.
 */
export class FileBrowserPort {
  async listFiles(projectId, zone) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async readFile(projectId, zone, relativePath) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
