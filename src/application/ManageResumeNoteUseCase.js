/**
 * Capa de Aplicación: ManageResumeNoteUseCase
 * Lee, lista y descarta la «nota de reanudación» que el agente deja antes
 * de reiniciar Jarvis. La escribe el propio agente (está en su workspace);
 * aquí sólo se consulta y se borra.
 */
export class ManageResumeNoteUseCase {
  constructor(resumeNotePort) {
    this.resumeNotePort = resumeNotePort;
  }

  async get(projectId) {
    return await this.resumeNotePort.get(projectId);
  }

  async list(projectIds) {
    return await this.resumeNotePort.list(projectIds);
  }

  async clear(projectId) {
    return await this.resumeNotePort.clear(projectId);
  }
}
