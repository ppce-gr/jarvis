import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBrowserPort } from '../../domain/ports/FileBrowserPort.js';

/**
 * Adaptador de Infraestructura: FileSystemBrowserAdapter
 * Explora las zonas `code/` y `logs/` de un proyecto.
 *
 * Seguridad: sólo se permiten las zonas declaradas y se bloquea cualquier
 * ruta que intente salir de ellas (path traversal), ya que la interfaz
 * estará expuesta en la red local y no queremos que un enlace mal formado
 * permita leer ficheros del sistema.
 */
export class FileSystemBrowserAdapter extends FileBrowserPort {
  static ALLOWED_ZONES = new Set(['code', 'logs', 'conceptual']);
  static MAX_FILE_BYTES = 256 * 1024; // 256 KB: suficiente para texto, seguro para la Pi 3B
  static MAX_DEPTH = 4;

  constructor(baseProjectsDir = path.resolve(process.cwd(), 'projects')) {
    super();
    this.baseProjectsDir = baseProjectsDir;
  }

  _zoneDir(projectId, zone) {
    if (!FileSystemBrowserAdapter.ALLOWED_ZONES.has(zone)) {
      throw new Error('ZONE_NOT_ALLOWED');
    }
    return path.join(this.baseProjectsDir, projectId, zone);
  }

  async listFiles(projectId, zone) {
    const zoneDir = this._zoneDir(projectId, zone);
    const results = [];

    const walk = async (dir, depth) => {
      if (depth > FileSystemBrowserAdapter.MAX_DEPTH) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // ocultos y .git fuera
        const full = path.join(dir, entry.name);
        const rel = path.relative(zoneDir, full);
        if (entry.isDirectory()) {
          results.push({ type: 'dir', path: rel });
          await walk(full, depth + 1);
        } else {
          let size = 0;
          try {
            size = (await fs.stat(full)).size;
          } catch { /* ignorar */ }
          results.push({ type: 'file', path: rel, size });
        }
      }
    };

    await fs.mkdir(zoneDir, { recursive: true });
    await walk(zoneDir, 0);
    return results;
  }

  async readFile(projectId, zone, relativePath) {
    const zoneDir = this._zoneDir(projectId, zone);
    const resolved = path.resolve(zoneDir, relativePath);

    // Bloqueo de path traversal
    if (resolved !== zoneDir && !resolved.startsWith(zoneDir + path.sep)) {
      throw new Error('PATH_NOT_ALLOWED');
    }

    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw new Error('NOT_A_FILE');
    if (stats.size > FileSystemBrowserAdapter.MAX_FILE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }

    return await fs.readFile(resolved, 'utf8');
  }
}
