/**
 * Puerto: AttachmentPort
 * Contrato para los ficheros que el usuario adjunta a una idea: subirlos,
 * listarlos, moverlos a su sitio, desasociarlos sin borrarlos del disco o
 * borrarlos, dejando siempre historial.
 */
export class AttachmentPort {
  async list(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async save(projectId, nombre, contenido) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async move(projectId, nombre, destino) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async detach(projectId, nombre) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async remove(projectId, nombre) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
