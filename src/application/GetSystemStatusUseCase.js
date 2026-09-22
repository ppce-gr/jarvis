/**
 * Capa de Aplicación: GetSystemStatusUseCase
 * Estado del propio Jarvis: versión, si hay cambios locales, ancla de
 * reversión y resultado de la última actualización.
 */
export class GetSystemStatusUseCase {
  constructor(systemUpdateAdapter) {
    this.systemUpdateAdapter = systemUpdateAdapter;
  }

  async execute() {
    return await this.systemUpdateAdapter.getStatus();
  }
}
