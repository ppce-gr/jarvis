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
  constructor(baseProjectsDir = path.resolve(process.cwd(), 'projects')) {
    super();
    this.baseProjectsDir = baseProjectsDir;
  }

  async findAll() {
    try {
      await fs.mkdir(this.baseProjectsDir, { recursive: true });
      const entries = await fs.readdir(this.baseProjectsDir, { withFileTypes: true });
      const projects = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
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
    const projectDir = path.join(this.baseProjectsDir, projectId);
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
        status: 'activa'
      });
    } catch {
      return null;
    }
  }

  async save(project) {
    const projectDir = path.join(this.baseProjectsDir, project.id);
    await fs.mkdir(path.join(projectDir, 'conceptual'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'code'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'logs'), { recursive: true });

    if (project.description) {
      await fs.writeFile(path.join(projectDir, 'README.md'), project.description, 'utf8');
    }
    return project;
  }
}
