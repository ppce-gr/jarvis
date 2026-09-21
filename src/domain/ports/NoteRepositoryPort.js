/**
 * Puerto de Infraestructura: NoteRepositoryPort
 * Define el contrato abstracto para la gestión de notas conceptuales y archivos Markdown.
 */
export class NoteRepositoryPort {
  async findByProject(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async findById(projectId, noteId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async save(note) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
