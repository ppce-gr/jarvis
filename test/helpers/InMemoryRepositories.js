import { Note } from '../../src/domain/Note.js';

/**
 * Dobles de prueba (fakes) en memoria.
 * Demuestran la portabilidad de la arquitectura hexagonal: los casos de uso
 * funcionan igual con estos adaptadores que con el sistema de ficheros real.
 * Devuelven entidades de dominio (Note), igual que el adaptador real.
 */
export class InMemoryProjectRepository {
  constructor() { this.projects = new Map(); }
  async findAll() { return [...this.projects.values()]; }
  async findById(id) { return this.projects.get(id) || null; }
  async save(project) { this.projects.set(project.id, project); return project; }
}

export class InMemoryNoteRepository {
  constructor() { this.notes = new Map(); }
  _key(projectId, noteId) { return `${projectId}::${noteId}`; }
  _toEntity(note) {
    return note instanceof Note ? note : new Note(note);
  }
  async findByProject(projectId) {
    return [...this.notes.values()]
      .filter((n) => n.projectId === projectId)
      .map((n) => this._toEntity(n));
  }
  async findById(projectId, noteId) {
    const note = this.notes.get(this._key(projectId, noteId));
    return note ? this._toEntity(note) : null;
  }
  async save(note) {
    this.notes.set(this._key(note.projectId, note.id), this._toEntity(note));
    return note;
  }
}

export class InMemoryOrchestratorAdapter {
  constructor() { this.calls = []; }
  async executeTask(projectId, instruction) {
    this.calls.push({ projectId, instruction });
    return { success: true, projectId, instruction };
  }
}
