/**
 * Capa de Aplicación: ToggleServiceUseCase
 * Enciende o apaga una capacidad de Jarvis (hablar, oír, …).
 */
export class ToggleServiceUseCase {
  constructor(systemServicesPort) {
    this.systemServicesPort = systemServicesPort;
  }

  async execute(id, action) {
    if (!id) throw new Error('SERVICE_ID_REQUIRED');
    if (action !== 'activar' && action !== 'desactivar') {
      throw new Error('SERVICE_ACTION_INVALID');
    }
    return await this.systemServicesPort.toggle(String(id), action);
  }
}
