/**
 * Capa de Aplicación: RunOrchestratorTaskUseCase
 * Orquesta la ejecución de una instrucción sobre un proyecto a través del puerto de orquestación.
 */
export class RunOrchestratorTaskUseCase {
  constructor(orchestratorAdapter) {
    this.orchestratorAdapter = orchestratorAdapter;
  }

  async execute(projectId, instruction) {
    if (!instruction || !projectId) {
      throw new Error('Project ID and instruction are required');
    }
    return await this.orchestratorAdapter.executeTask(projectId, instruction);
  }
}
