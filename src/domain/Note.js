/**
 * Dominio: Entidad Note (Nota Conceptual / Subidea)
 * Representa un archivo Markdown conceptual dentro de un proyecto,
 * conteniendo metadatos (Frontmatter) y enlaces internos (wikilinks).
 */
export class Note {
  constructor({ id, projectId, title, content = '', frontmatter = {}, rawPath = '' }) {
    if (!id || !projectId) {
      throw new Error('Note ID and Project ID are required');
    }
    this.id = id;               // Nombre del archivo sin extensión (ej: subidea-prueba)
    this.projectId = projectId; // ID del proyecto al que pertenece
    this.title = title || id;
    this.content = content;     // Cuerpo del Markdown (sin frontmatter)
    this.frontmatter = frontmatter; // Objeto con los metadatos YAML
    this.rawPath = rawPath;     // Ruta absoluta en disco
  }

  /**
   * Extrae los wikilinks [[nombre-nota]] presentes en el contenido.
   * Cumple con la regla de indexado y relación entre ideas hermanas.
   *
   * Se ignoran los bloques de código (```) y el código en línea (`...`)
   * para no confundir ejemplos de sintaxis con enlaces reales.
   */
  extractWikilinks() {
    const withoutCodeBlocks = this.content.replace(/```[\s\S]*?```/g, '');
    const withoutInlineCode = withoutCodeBlocks.replace(/`[^`]*`/g, '');

    const regex = /\[\[(.*?)\]\]/g;
    const links = [];
    let match;
    while ((match = regex.exec(withoutInlineCode)) !== null) {
      links.push(match[1].trim());
    }
    return [...new Set(links)]; // Únicos
  }
}
