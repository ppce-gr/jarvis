/**
 * Dominio: Entidad Project
 * Representa una idea/proyecto que agrupa notas conceptuales, código fuente y logs.
 */
export class Project {
  constructor({ id, name, description = '', status = 'incubadora', createdAt = new Date(), modifiedAt = null }) {
    if (!id || typeof id !== 'string') {
      throw new Error('Project ID is required and must be a valid string identifier');
    }
    this.id = id;
    this.name = name || id;
    this.description = description;
    this.status = status; // 'incubadora' | 'activa' | 'archivada'
    this.createdAt = createdAt;
    // Fecha del fichero más reciente de la idea (para ordenar por «lo último»).
    this.modifiedAt = modifiedAt;
  }

  isArchived() {
    return this.status === 'archivada';
  }
}
