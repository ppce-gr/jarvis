/**
 * Puerto de Infraestructura: OrchestratorPort
 * ------------------------------------------------------------------
 * Contrato para ejecutar trabajo de agentes sobre un proyecto.
 *
 * Diseño asíncrono deliberado: en una Raspberry Pi 3B una tarea de
 * agentes puede tardar minutos y consumir ~170 MB de RAM. Si el HTTP
 * request esperase al resultado, el móvil se quedaría colgado y una
 * microcaída de red mataría la percepción de progreso.
 *
 * Por eso `executeTask` ENCOLA y devuelve un acuse inmediato; el
 * progreso se sigue por la bitácora y por `listTasks`.
 *
 * Cualquier motor (DSH headless, DSH SDK persistente, API directa)
 * puede implementar este puerto sin que el dominio se entere.
 */
export class OrchestratorPort {
  /**
   * Encola una orden para un proyecto.
   * @returns {Promise<{accepted: boolean, taskId: string, status: string}>}
   */
  async executeTask(projectId, instruction) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Lista las tareas conocidas de un proyecto (más recientes primero).
   * @returns {Promise<Array<object>>}
   */
  async listTasks(projectId) {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
