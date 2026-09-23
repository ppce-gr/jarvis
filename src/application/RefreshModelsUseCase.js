/**
 * Capa de Aplicación: RefreshModelsUseCase
 * - Sin argumento: restablece el registro de salud y lanza una comprobación
 *   completa en segundo plano (el avance se consulta con GetModelHealthUseCase).
 * - Con `model`: vuelve a comprobar sólo ese modelo, sin tocar el resto.
 */
export class RefreshModelsUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute(model = null) {
    if (model !== null && model !== undefined && String(model).trim() !== '') {
      return await this.conversationAdapter.refreshModel(String(model));
    }
    return await this.conversationAdapter.refreshModels();
  }
}
