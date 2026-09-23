/**
 * Capa de Aplicación: RefreshModelsUseCase
 * Restablece el registro de salud de los modelos y lanza una comprobación
 * completa en segundo plano. El avance se consulta con GetModelHealthUseCase.
 */
export class RefreshModelsUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute() {
    return await this.conversationAdapter.refreshModels();
  }
}
