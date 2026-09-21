/**
 * Puerto de Infraestructura: OrchestratorPort
 * Define el contrato abstracto para la ejecución del orquestador de agentes (DSH / Subagents).
 */
export class OrchestratorPort {
  async executeTask(projectId, instruction) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
