/**
 * Puerto: SystemHealthPort
 * Lectura de la salud de la máquina donde corre Jarvis: temperatura, disco,
 * memoria, carga y tiempo encendido. El dominio no sabe de sysfs, /proc ni Node.
 */
export class SystemHealthPort {
  async read() {
    throw new Error('METHOD_NOT_IMPLEMENTED');
  }
}
