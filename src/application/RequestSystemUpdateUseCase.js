/**
 * Capa de Aplicación: RequestSystemUpdateUseCase
 * Pide una actualización. Sólo deja la bandera: quien actualiza es systemd,
 * fuera del proceso de Jarvis, para poder revertir si el arranque falla.
 */
export class RequestSystemUpdateUseCase {
  constructor(systemUpdateAdapter) {
    this.systemUpdateAdapter = systemUpdateAdapter;
  }

  async execute() {
    return await this.systemUpdateAdapter.requestUpdate();
  }
}
