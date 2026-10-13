/**
 * Puerto de dominio: SystemServicesPort
 * ------------------------------------------------------------------
 * Define cómo la aplicación consulta y conmuta las capacidades de Jarvis
 * (hablar, oír, calibración y servicios del sistema), sin saber cómo se
 * implementan por debajo.
 */
export class SystemServicesPort {
  /** Devuelve { recursos, servicios: [...] }. */
  async list() {
    throw new Error('SystemServicesPort.list no implementado');
  }

  /** Activa o desactiva un servicio por su id. */
  async toggle(_id, _action) {
    throw new Error('SystemServicesPort.toggle no implementado');
  }
}
