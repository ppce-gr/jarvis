import { Project } from '../domain/Project.js';
import { Note } from '../domain/Note.js';

/**
 * Capa de Aplicación: CreateProjectUseCase
 * Crea un nuevo proyecto/idea con su estructura de carpetas
 * (conceptual/, code/, logs/) y su README inicial.
 */
export class CreateProjectUseCase {
  constructor(projectRepository, noteRepository) {
    this.projectRepository = projectRepository;
    this.noteRepository = noteRepository;
  }

  /**
   * Normaliza un nombre libre a un identificador válido de carpeta (slug).
   */
  static slugify(value) {
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // quitar acentos
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  async execute({ id, name, description = '' } = {}) {
    const projectId = CreateProjectUseCase.slugify(id || name || '');
    if (!projectId) {
      throw new Error('PROJECT_ID_REQUIRED');
    }

    const existing = await this.projectRepository.findById(projectId);
    if (existing) {
      throw new Error('PROJECT_ALREADY_EXISTS');
    }

    const project = new Project({
      id: projectId,
      name: name || projectId,
      description: description || `# ${name || projectId}\n\n${description}`.trim(),
      status: 'activa'
    });

    await this.projectRepository.save(project);

    // Nota índice inicial para que el proyecto nazca navegable
    await this.noteRepository.save(new Note({
      id: '_indice',
      projectId,
      title: name || projectId,
      frontmatter: { title: name || projectId, status: 'activa' },
      content: `# ${name || projectId}\n\n${description || 'Idea en fase conceptual.'}\n\n## Subideas\n\n- [[qa-dudas]]: Preguntas y respuestas del proyecto.\n`
    }));

    await this.noteRepository.save(new Note({
      id: 'qa-dudas',
      projectId,
      title: 'Preguntas y Respuestas',
      frontmatter: { title: 'Preguntas y Respuestas', project: projectId },
      content: `# Q&A / Dudas\n\n## Pregunta 1: (pendiente)\n- **Respuesta:** (pendiente)\n`
    }));

    return project;
  }
}
