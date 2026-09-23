/**
 * Capa de Aplicación: GetModelHealthUseCase
 * Devuelve la salud conocida de los modelos: qué funciona, qué se agotó por
 * cuota y qué se retiró por no existir o no estar disponible.
 */
export class GetModelHealthUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async execute() {
    return await this.conversationAdapter.getModelHealth();
  }
}
