/**
 * Capa de Aplicación: ListOrchestratorTasksUseCase
 * Devuelve las tareas conocidas de un proyecto para que la interfaz
 * muestre el estado del orquestador (en cola, en curso, completada…).
 */
export class ListOrchestratorTasksUseCase {
  constructor(orchestratorAdapter) {
    this.orchestratorAdapter = orchestratorAdapter;
  }

  async execute(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    return await this.orchestratorAdapter.listTasks(projectId);
  }
}
