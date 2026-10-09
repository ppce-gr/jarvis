/**
 * Puerto: ResumeNotePort
 * ==================================================================
 * Contrato para la «nota de reanudación»: un fichero Markdown que el
 * agente deja en la raíz de su workspace justo ANTES de pedir el
 * auto-reinicio de Jarvis, diciendo qué estaba haciendo, qué le falta y
 * cuál es el siguiente paso.
 *
 * El reinicio mata la sesión del agente. Al volver, el chat lee esta
 * nota y se la inyecta en el primer mensaje, de modo que retoma el
 * trabajo donde lo dejó en vez de empezar de cero.
 *
 *   - `get(projectId)`   → `{ existe, contenido, modificadoEn }`
 *   - `clear(projectId)` → la borra (el agente terminó la tarea)
 *   - `list(ids)`        → las que existan, para avisar en la interfaz
 */
export class ResumeNotePort {
  async get(_projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async clear(_projectId) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
  async list(_projectIds) { throw new Error('METHOD_NOT_IMPLEMENTED'); }
}
