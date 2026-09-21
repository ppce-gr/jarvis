/**
 * Puerto de Infraestructura: ProjectRepositoryPort
 * Define el contrato abstracto para la persistencia y lectura de proyectos e ideas.
 * Siguiendo SOLID (ISP - Interface Segregation), separa las operaciones de dominio.
 */
export class ProjectRepositoryPort {
  async findAll() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async findById(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  async save(project) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
