/**
 * Capa de Aplicación: GetProjectsUseCase
 * Caso de uso para obtener todos los proyectos disponibles.
 */
export class GetProjectsUseCase {
  constructor(projectRepository) {
    this.projectRepository = projectRepository;
  }

  async execute() {
    return await this.projectRepository.findAll();
  }
}
