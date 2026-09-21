import { Note } from '../domain/Note.js';

/**
 * Capa de Aplicación: SaveNoteUseCase
 * Lectura y guardado de notas conceptuales (Markdown + Frontmatter).
 * Es el caso de uso que permite editar ideas desde la interfaz web.
 */
export class SaveNoteUseCase {
  constructor(noteRepository) {
    this.noteRepository = noteRepository;
  }

  async getNote(projectId, noteId) {
    const note = await this.noteRepository.findById(projectId, noteId);
    if (!note) return null;
    return {
      id: note.id,
      projectId: note.projectId,
      title: note.title,
      frontmatter: note.frontmatter,
      content: note.content,
      wikilinks: note.extractWikilinks()
    };
  }

  async execute({ projectId, noteId, title, content = '', frontmatter = {} } = {}) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    if (!noteId) throw new Error('NOTE_ID_REQUIRED');

    const note = new Note({
      id: noteId,
      projectId,
      title: title || noteId,
      content,
      frontmatter: { ...frontmatter, title: title || frontmatter.title || noteId }
    });

    await this.noteRepository.save(note);

    return {
      id: note.id,
      projectId: note.projectId,
      title: note.title,
      frontmatter: note.frontmatter,
      content: note.content,
      wikilinks: note.extractWikilinks()
    };
  }
}
