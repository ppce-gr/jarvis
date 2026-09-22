/**
 * Puerto de Infraestructura: SystemUpdatePort
 * ------------------------------------------------------------------
 * Contrato para consultar y disparar la actualización del propio Jarvis.
 *
 * Detalle importante de diseño: este puerto **no actualiza**. Sólo deja la
 * petición en un fichero bandera y lee el estado. Quien actualiza es systemd,
 * desde fuera del proceso de Jarvis.
 *
 * El motivo es el problema del bootstrap: si Jarvis se reiniciara a sí mismo y
 * el código nuevo no arrancase, se quedaría sin la herramienta capaz de
 * recuperarlo. Un proceso no puede verificar con fiabilidad su propio reinicio.
 */
export class SystemUpdatePort {
  /**
   * Estado del sistema: versión actual, si hay cambios locales, ancla de
   * reversión, si hay una actualización pedida y el resultado de la última.
   * @returns {Promise<object>}
   */
  async getStatus() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Pide una actualización dejando la bandera que vigila systemd.
   * No requiere privilegios y no reinicia nada por sí mismo.
   */
  async requestUpdate() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }

  /**
   * Consulta si el remoto tiene novedades (sólo lectura, no aplica nada).
   */
  async checkForUpdates() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
