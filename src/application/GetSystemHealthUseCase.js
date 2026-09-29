/**
 * Capa de Aplicación: GetSystemHealthUseCase
 * Devuelve la salud de la máquina (temperatura, disco, memoria, carga).
 */
export class GetSystemHealthUseCase {
  constructor(systemHealthAdapter) {
    this.systemHealthAdapter = systemHealthAdapter;
  }

  async execute() {
    return await this.systemHealthAdapter.read();
  }
}
