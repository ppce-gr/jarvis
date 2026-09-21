/**
 * Capa de Aplicación: GetProjectConceptualTreeUseCase
 * Obtiene el árbol conceptual completo de un proyecto (todas sus notas Markdown y wikilinks).
 */
export class GetProjectConceptualTreeUseCase {
  constructor(noteRepository) {
    this.noteRepository = noteRepository;
  }

  async execute(projectId) {
    const notes = await this.noteRepository.findByProject(projectId);
    
    // Mapear notas con sus wikilinks extraídos para construir la red mental
    return notes.map(note => ({
      id: note.id,
      title: note.title,
      frontmatter: note.frontmatter,
      content: note.content,
      wikilinks: note.extractWikilinks()
    }));
  }
}
