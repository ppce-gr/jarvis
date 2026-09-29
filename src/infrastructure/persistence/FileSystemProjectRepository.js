import fs from 'node:fs/promises';
import path from 'node:path';
import { Project } from '../../domain/Project.js';
import { ProjectRepositoryPort } from '../../domain/ports/ProjectRepositoryPort.js';

/**
 * Adaptador de Infraestructura: FileSystemProjectRepository
 * Implementa ProjectRepositoryPort utilizando el sistema de ficheros local (Raspberry Pi).
 * Lee directamente de la carpeta `projects/` sin bases de datos pesadas.
 */
export class FileSystemProjectRepository extends ProjectRepositoryPort {
  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  async findAll() {
    try {
      await fs.mkdir(this.brainDir, { recursive: true });
      const entries = await fs.readdir(this.brainDir, { withFileTypes: true });
      const projects = [];

      for (const entry of entries) {
        // Los directorios ocultos se ignoran: la carpeta de memoria es a su vez
        // un repositorio Git, y su `.git` no es una idea del usuario.
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const projectId = entry.name;
          const project = await this.findById(projectId);
          if (project) {
            projects.push(project);
          }
        }
      }
      return projects;
    } catch (error) {
      console.error('Error reading projects directory:', error);
      return [];
    }
  }

  async findById(projectId) {
    const projectDir = path.join(this.brainDir, projectId);
    const readmePath = path.join(projectDir, 'README.md');

    try {
      const stats = await fs.stat(projectDir);
      if (!stats.isDirectory()) return null;

      let description = '';
      try {
        description = await fs.readFile(readmePath, 'utf8');
      } catch {
        // README opcional
      }

      return new Project({
        id: projectId,
        name: projectId,
        description: description.trim(),
        status: 'activa',
        createdAt: stats.birthtime,
        modifiedAt: await this._ultimaModificacion(projectDir)
      });
    } catch {
      return null;
    }
  }

  /**
   * Fecha de la última modificación REAL de la idea: la del fichero más
   * reciente que contiene. Mirar sólo la carpeta no sirve: editar una nota no
   * cambia la fecha de su carpeta. Se limita la profundidad y el número de
   * entradas para no castigar a la Pi con ideas grandes.
   */
  async _ultimaModificacion(dir, { maxProfundidad = 4, limite = 600 } = {}) {
    let ultima = 0;
    let vistos = 0;
    const pila = [{ dir, nivel: 0 }];
    while (pila.length && vistos < limite) {
      const { dir: actual, nivel } = pila.pop();
      let entries;
      try {
        entries = await fs.readdir(actual, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        vistos += 1;
        if (vistos > limite) break;
        const full = path.join(actual, entry.name);
        if (entry.isDirectory()) {
          if (nivel < maxProfundidad) pila.push({ dir: full, nivel: nivel + 1 });
        } else {
          try {
            const st = await fs.stat(full);
            if (st.mtimeMs > ultima) ultima = st.mtimeMs;
          } catch { /* ignorar */ }
        }
      }
    }
    return ultima ? new Date(ultima) : null;
  }

  async save(project) {
    const projectDir = path.join(this.brainDir, project.id);
    await fs.mkdir(path.join(projectDir, 'conceptual'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'code'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'logs'), { recursive: true });

    if (project.description) {
      await fs.writeFile(path.join(projectDir, 'README.md'), project.description, 'utf8');
    }
    return project;
  }
}
