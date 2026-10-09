import fs from 'node:fs/promises';
import path from 'node:path';
import { ResumeNotePort } from '../../domain/ports/ResumeNotePort.js';
import { resolverWorkspace } from './resolverWorkspace.js';

/**
 * Adaptador: FileSystemResumeNoteAdapter
 * ==================================================================
 * La nota de reanudación es `tarea-en-curso.md` en la raíz del workspace
 * del proyecto. Ese emplazamiento no es casual:
 *
 *   - El agente sólo puede escribir dentro de su workspace (el sandbox lo
 *     confina ahí), así que la nota tiene que vivir ahí para que pueda
 *     dejarla SOLO, sin pedir permiso.
 *   - En el proyecto de automodificación el workspace es el repositorio
 *     del código, y el actualizador aborta si el árbol de Git está sucio
 *     (barrera 1). Por eso el fichero va en `.gitignore`: si no, el mero
 *     hecho de escribir la nota impediría la actualización.
 *
 * Se corta a `MAX_BYTES` para que una nota gigante no se cuele entera en
 * el prompt. Si está más allá, se recorta y se avisa en el texto.
 */
export class FileSystemResumeNoteAdapter extends ResumeNotePort {
  static NOMBRE = 'tarea-en-curso.md';
  static MAX_BYTES = 64 * 1024;

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  async _ruta(projectId) {
    const workspace = await resolverWorkspace(this.brainDir, projectId);
    return path.join(workspace, FileSystemResumeNoteAdapter.NOMBRE);
  }

  async get(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const ruta = await this._ruta(projectId);
    try {
      const st = await fs.stat(ruta);
      if (!st.isFile()) return { existe: false };
      const bruto = await fs.readFile(ruta, 'utf8');
      const recortado = bruto.length > FileSystemResumeNoteAdapter.MAX_BYTES;
      const contenido = recortado
        ? `${bruto.slice(0, FileSystemResumeNoteAdapter.MAX_BYTES)}\n\n[…nota recortada…]`
        : bruto;
      return {
        existe: true,
        contenido,
        modificadoEn: st.mtime?.toISOString?.() || null
      };
    } catch {
      return { existe: false };
    }
  }

  async clear(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const ruta = await this._ruta(projectId);
    await fs.rm(ruta, { force: true });
    return { borrada: true };
  }

  /** Notas presentes, para el aviso de la interfaz. */
  async list(projectIds = []) {
    const tareas = [];
    for (const projectId of projectIds) {
      const nota = await this.get(projectId);
      if (!nota.existe) continue;
      tareas.push({
        projectId,
        extracto: FileSystemResumeNoteAdapter.extracto(nota.contenido),
        modificadoEn: nota.modificadoEn
      });
    }
    return tareas;
  }

  /**
   * Frase corta para el aviso, sin volcar la nota entera. Se prefiere el
   * primer párrafo de verdad (no un encabezado); si la nota es sólo
   * cabeceras, se usa la primera.
   */
  static extracto(contenido) {
    let primerTitulo = '';
    for (const linea of String(contenido || '').split('\n')) {
      const limpia = linea.replace(/\s+/g, ' ').trim();
      if (!limpia) continue;
      const esTitulo = /^#+\s/.test(limpia) || /^qu[eé]\b/i.test(limpia);
      if (esTitulo) {
        if (!primerTitulo) primerTitulo = limpia.replace(/^#+\s*/, '');
        continue;
      }
      return limpia.slice(0, 120);
    }
    return primerTitulo.slice(0, 120);
  }
}
