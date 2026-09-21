/**
 * Dominio: Entidad Project
 * Representa una idea/proyecto que agrupa notas conceptuales, código fuente y logs.
 */
export class Project {
  constructor({ id, name, description = '', status = 'incubadora', createdAt = new Date() }) {
    if (!id || typeof id !== 'string') {
      throw new Error('Project ID is required and must be a valid string identifier');
    }
    this.id = id;
    this.name = name || id;
    this.description = description;
    this.status = status; // 'incubadora' | 'activa' | 'archivada'
    this.createdAt = createdAt;
  }

  isArchived() {
    return this.status === 'archivada';
  }
}
