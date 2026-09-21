import fs from 'node:fs/promises';
import path from 'node:path';
import { Note } from '../../domain/Note.js';
import { NoteRepositoryPort } from '../../domain/ports/NoteRepositoryPort.js';

/**
 * Adaptador de Infraestructura: FileSystemNoteRepository
 * Gestiona la lectura y escritura de notas Markdown (Frontmatter + Cuerpo)
 * cumpliendo con los estándares de Obsidian y nuestro motor de indexación sin base de datos.
 */
export class FileSystemNoteRepository extends NoteRepositoryPort {
  constructor(baseProjectsDir = path.resolve(process.cwd(), 'projects')) {
    super();
    this.baseProjectsDir = baseProjectsDir;
  }

  _getConceptualDir(projectId) {
    return path.join(this.baseProjectsDir, projectId, 'conceptual');
  }

  /**
   * Parser ultra-ligero de Frontmatter YAML (sin dependencias externas pesadas).
   */
  _parseMarkdownFile(rawContent, filePath, projectId, noteId) {
    let frontmatter = {};
    let content = rawContent;

    if (rawContent.startsWith('---')) {
      const parts = rawContent.split('---');
      if (parts.length >= 3) {
        const yamlLines = parts[1].trim().split('\n');
        for (const line of yamlLines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            let val = line.slice(colonIdx + 1).trim();
            // Limpiar comillas si las tiene
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            frontmatter[key] = val;
          }
        }
        content = parts.slice(2).join('---').trim();
      }
    }

    const title = frontmatter.title || noteId;

    return new Note({
      id: noteId,
      projectId,
      title,
      content,
      frontmatter,
      rawPath: filePath
    });
  }

  _serializeMarkdownFile(note) {
    let yamlHeader = '---\n';
    for (const [key, value] of Object.entries(note.frontmatter)) {
      yamlHeader += `${key}: "${value}"\n`;
    }
    yamlHeader += '---\n\n';
    return yamlHeader + note.content;
  }

  async findByProject(projectId) {
    const conceptualDir = this._getConceptualDir(projectId);
    try {
      await fs.mkdir(conceptualDir, { recursive: true });
      const files = await fs.readdir(conceptualDir);
      const notes = [];

      for (const file of files) {
        if (file.endsWith('.md')) {
          const noteId = file.replace(/\.md$/, '');
          const filePath = path.join(conceptualDir, file);
          const raw = await fs.readFile(filePath, 'utf8');
          const note = this._parseMarkdownFile(raw, filePath, projectId, noteId);
          notes.push(note);
        }
      }
      return notes;
    } catch (error) {
      console.error(`Error reading notes for project ${projectId}:`, error);
      return [];
    }
  }

  async findById(projectId, noteId) {
    const conceptualDir = this._getConceptualDir(projectId);
    const filePath = path.join(conceptualDir, `${noteId}.md`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return this._parseMarkdownFile(raw, filePath, projectId, noteId);
    } catch {
      return null;
    }
  }

  async save(note) {
    const conceptualDir = this._getConceptualDir(note.projectId);
    await fs.mkdir(conceptualDir, { recursive: true });
    const filePath = path.join(conceptualDir, `${note.id}.md`);
    const serialized = this._serializeMarkdownFile(note);
    await fs.writeFile(filePath, serialized, 'utf8');
    note.rawPath = filePath;
    return note;
  }
}
