/**
 * Capa de Aplicación: CheckForUpdatesUseCase
 * Consulta si el remoto tiene novedades. Es de sólo lectura: no aplica nada.
 */
export class CheckForUpdatesUseCase {
  constructor(systemUpdateAdapter) {
    this.systemUpdateAdapter = systemUpdateAdapter;
  }

  async execute() {
    return await this.systemUpdateAdapter.checkForUpdates();
  }
}
