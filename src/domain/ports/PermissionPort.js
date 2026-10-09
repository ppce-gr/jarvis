/**
 * Puerto: PermissionPort
 * Peticiones de acciones privilegiadas (root) de una idea: el agente pide, el
 * usuario aprueba una a una con su PIN, un helper de root ejecuta y queda
 * resultado e historial.
 */
export class PermissionPort {
  async list(projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async request(projectId, comando, motivo, cwd) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async approve(projectId, id, pin) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async reject(projectId, id, motivo) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
}
