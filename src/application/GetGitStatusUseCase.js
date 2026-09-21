/**
 * Capa de Aplicación: GetGitStatusUseCase
 * Expone el estado del respaldo Git para que la interfaz muestre si hay
 * cambios sin guardar (y recuerde al usuario subirlos a un remoto).
 */
export class GetGitStatusUseCase {
  constructor(gitSyncAdapter) {
    this.gitSyncAdapter = gitSyncAdapter;
  }

  async execute() {
    return await this.gitSyncAdapter.status();
  }
}
