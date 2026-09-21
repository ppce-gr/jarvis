/**
 * Capa de Aplicación: RunOrchestratorTaskUseCase
 * ------------------------------------------------------------------
 * Encola una orden de trabajo sobre un proyecto.
 *
 * Semántica asíncrona: NO espera a que los agentes terminen. Devuelve
 * un acuse con el identificador de tarea para que la interfaz pueda
 * seguir el progreso por la bitácora sin bloquearse.
 */
export class RunOrchestratorTaskUseCase {
  constructor(orchestratorAdapter) {
    this.orchestratorAdapter = orchestratorAdapter;
  }

  async execute(projectId, instruction) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    if (!instruction || !String(instruction).trim()) {
      throw new Error('INSTRUCTION_REQUIRED');
    }
    return await this.orchestratorAdapter.executeTask(projectId, String(instruction).trim());
  }
}
