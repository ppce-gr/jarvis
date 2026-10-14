import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBrowserPort } from '../../domain/ports/FileBrowserPort.js';
import { crearZip } from './ZipArchive.js';

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
  static MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024; // 128 MB: descarga directa, no para pintar
  static MAX_FOLDER_BYTES = 128 * 1024 * 1024; // 128 MB sin comprimir al empaquetar una carpeta
  static MAX_DEPTH = 4;

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  _zoneDir(projectId, zone) {
    if (!FileSystemBrowserAdapter.ALLOWED_ZONES.has(zone)) {
      throw new Error('ZONE_NOT_ALLOWED');
    }
    return path.join(this.brainDir, projectId, zone);
  }

  /** Resuelve una ruta relativa dentro de la zona, bloqueando el path traversal. */
  _resolveZonePath(zoneDir, relativePath) {
    const resolved = path.resolve(zoneDir, String(relativePath ?? ''));
    if (resolved !== zoneDir && !resolved.startsWith(zoneDir + path.sep)) {
      throw new Error('PATH_NOT_ALLOWED');
    }
    return resolved;
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
    const resolved = this._resolveZonePath(zoneDir, relativePath);

    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw new Error('NOT_A_FILE');
    if (stats.size > FileSystemBrowserAdapter.MAX_FILE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }

    return await fs.readFile(resolved, 'utf8');
  }

  /**
   * Devuelve el contenido binario de un fichero para descargarlo. A diferencia
   * de `readFile`, no está pensado para pintarlo: admite ficheros más grandes
   * (con un tope) y no interpreta el texto.
   */
  async downloadFile(projectId, zone, relativePath) {
    const zoneDir = this._zoneDir(projectId, zone);
    const resolved = this._resolveZonePath(zoneDir, relativePath);

    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw new Error('NOT_A_FILE');
    if (stats.size > FileSystemBrowserAdapter.MAX_DOWNLOAD_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }

    return {
      name: path.basename(resolved),
      size: stats.size,
      content: await fs.readFile(resolved)
    };
  }

  /**
   * Empaqueta una carpeta (y sus subcarpetas) en un ZIP creado al vuelo. Los
   * nombres dentro del ZIP son las rutas relativas a la zona, así que la
   * carpeta pedida queda como raíz. Se saltan ocultos y hay tope de tamaño.
   */
  async downloadFolder(projectId, zone, relativePath) {
    const zoneDir = this._zoneDir(projectId, zone);
    const resolved = this._resolveZonePath(zoneDir, relativePath || '');

    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) throw new Error('NOT_A_DIRECTORY');

    const entradas = [];
    let total = 0;
    const walk = async (dir) => {
      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!item.isFile()) continue;
        const info = await fs.stat(full).catch(() => null);
        if (!info) continue;
        total += info.size;
        if (total > FileSystemBrowserAdapter.MAX_FOLDER_BYTES) throw new Error('FOLDER_TOO_LARGE');
        entradas.push({
          name: path.relative(zoneDir, full).split(path.sep).join('/'),
          data: await fs.readFile(full)
        });
      }
    };
    await walk(resolved);

    const base = path.basename(resolved) || zone;
    return {
      name: `${base}.zip`,
      count: entradas.length,
      content: crearZip(entradas)
    };
  }
}
