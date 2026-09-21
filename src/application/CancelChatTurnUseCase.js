/**
 * Capa de Aplicación: CancelChatTurnUseCase
 * Detiene el turno en curso de la conversación de un proyecto.
 *
 * Con el adaptador ACP esto es una cancelación real: el agente conserva lo
 * hablado. Con el adaptador SDK no existe, y devuelve `{ cancelled: false }`.
 */
export class CancelChatTurnUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    return await this.conversationAdapter.cancel(projectId);
  }
}
