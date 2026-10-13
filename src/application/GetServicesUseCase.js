/**
 * Capa de Aplicación: GetServicesUseCase
 * Devuelve el estado de las capacidades de Jarvis y los recursos de la Pi.
 */
export class GetServicesUseCase {
  constructor(systemServicesPort) {
    this.systemServicesPort = systemServicesPort;
  }

  async execute() {
    return await this.systemServicesPort.list();
  }
}
