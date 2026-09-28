import fs from 'node:fs/promises';
import path from 'node:path';
import { AttachmentPort } from '../../domain/ports/AttachmentPort.js';

/**
 * Adaptador: FileSystemAttachmentAdapter
 * ==================================================================
 * La carpeta `adjuntos/` de una idea es la bandeja de entrada de ficheros
 * que el usuario le pasa al agente. Aquí NO se mezcla con `code/`.
 *
 * Decisiones (acordadas con el usuario):
 *  - Al **subir**, el fichero se copia a `<idea>/adjuntos/<nombre>`.
 *  - **Mover** lo lleva a su sitio dentro de la idea (p. ej. `code/imagenes/`)
 *    sin borrarlo del disco: deja de ser un adjunto y pasa a ser material.
 *  - **Desasociar** quita el fichero de la lista del proyecto pero lo deja
 *    DONDE ESTÁ (no se borra ni se mueve). Puede quedar huérfano a propósito.
 *  - **Borrar** sí lo elimina del disco.
 *  - Todo queda en el historial (`adjuntos/.historial.jsonl`).
 *
 * La "asociación" se lleva en un registro (`adjuntos/.registro.json`), no en
 * la mera presencia del fichero: así «desasociar» puede olvidarlo sin tocarlo.
 *
 * Seguridad: nombres saneados (sin rutas ni ocultos) y destinos confinados a
 * la carpeta de la idea (nada de `..` ni rutas absolutas).
 */
export class FileSystemAttachmentAdapter extends AttachmentPort {
  static MAX_BYTES = 12 * 1024 * 1024;       // 12 MB: holgado para imágenes, seguro en la Pi
  static CARPETA = 'adjuntos';
  static REGISTRO = '.registro.json';
  static HISTORIAL = '.historial.jsonl';
  static MAX_HISTORIAL = 300;

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  _projectDir(projectId) {
    return path.join(this.brainDir, projectId);
  }

  _dir(projectId) {
    return path.join(this._projectDir(projectId), FileSystemAttachmentAdapter.CARPETA);
  }

  _registroPath(projectId) {
    return path.join(this._dir(projectId), FileSystemAttachmentAdapter.REGISTRO);
  }

  _historialPath(projectId) {
    return path.join(this._dir(projectId), FileSystemAttachmentAdapter.HISTORIAL);
  }

  /** Nombre simple y seguro: sin rutas, sin ocultos, sin caracteres de control. */
  _limpiarNombre(nombre) {
    const original = String(nombre || '');
    if (original.includes('/') || original.includes('\\')) throw new Error('ATTACHMENT_NAME_INVALID');
    const limpio = original.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!limpio || limpio === '.' || limpio === '..' || limpio.startsWith('.')) {
      throw new Error('ATTACHMENT_NAME_INVALID');
    }
    if (limpio.length > 160) throw new Error('ATTACHMENT_NAME_TOO_LONG');
    return limpio;
  }

  /** Un destino relativo dentro de la idea, sin escapar de ella. */
  _resolverDestino(projectId, destino) {
    const base = this._projectDir(projectId);
    const original = String(destino || '').trim();
    if (!original) throw new Error('ATTACHMENT_DESTINATION_REQUIRED');
    if (original.startsWith('/') || original.includes('\\')) throw new Error('ATTACHMENT_DESTINATION_INVALID');
    const rel = original.replace(/\/+$/, '');
    if (!rel) throw new Error('ATTACHMENT_DESTINATION_REQUIRED');
    if (rel.split('/').some((p) => p === '..' || p === '' || p.startsWith('.'))) {
      throw new Error('ATTACHMENT_DESTINATION_INVALID');
    }
    const resuelto = path.resolve(base, rel);
    if (resuelto !== base && !resuelto.startsWith(base + path.sep)) {
      throw new Error('ATTACHMENT_DESTINATION_INVALID');
    }
    return resuelto;
  }

  async _leerRegistro(projectId) {
    try {
      const raw = await fs.readFile(this._registroPath(projectId), 'utf8');
      const datos = JSON.parse(raw);
      return (datos && typeof datos === 'object') ? datos : {};
    } catch {
      return {};
    }
  }

  async _escribirRegistro(projectId, registro) {
    await fs.mkdir(this._dir(projectId), { recursive: true });
    await fs.writeFile(this._registroPath(projectId), JSON.stringify(registro, null, 2), 'utf8');
  }

  async _registrar(projectId, entrada) {
    await fs.mkdir(this._dir(projectId), { recursive: true });
    const linea = JSON.stringify({ ...entrada, at: new Date().toISOString() });
    await fs.appendFile(this._historialPath(projectId), `${linea}\n`, 'utf8');
  }

  async _historial(projectId) {
    try {
      const raw = await fs.readFile(this._historialPath(projectId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .slice(-FileSystemAttachmentAdapter.MAX_HISTORIAL)
        .reverse();
    } catch {
      return [];
    }
  }

  async list(projectId) {
    const dir = this._dir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const registro = await this._leerRegistro(projectId);
    const adjuntos = [];
    for (const [nombre, meta] of Object.entries(registro)) {
      let stats = null;
      try { stats = await fs.stat(path.join(dir, nombre)); } catch { /* ya no está */ }
      adjuntos.push({
        nombre,
        bytes: stats?.size ?? meta?.bytes ?? 0,
        subidoEn: meta?.subidoEn || null,
        presente: Boolean(stats && stats.isFile())
      });
    }
    adjuntos.sort((a, b) => String(b.subidoEn || '').localeCompare(String(a.subidoEn || '')));
    return { adjuntos, historial: await this._historial(projectId) };
  }

  async save(projectId, nombre, contenido) {
    if (!Buffer.isBuffer(contenido)) throw new Error('ATTACHMENT_CONTENT_INVALID');
    if (contenido.length === 0) throw new Error('ATTACHMENT_EMPTY');
    if (contenido.length > FileSystemAttachmentAdapter.MAX_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
    const limpio = this._limpiarNombre(nombre);
    const dir = this._dir(projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, limpio), contenido);
    const registro = await this._leerRegistro(projectId);
    registro[limpio] = { subidoEn: new Date().toISOString(), bytes: contenido.length };
    await this._escribirRegistro(projectId, registro);
    await this._registrar(projectId, { accion: 'subido', nombre: limpio, bytes: contenido.length });
    return { nombre: limpio, bytes: contenido.length };
  }

  async move(projectId, nombre, destino) {
    const limpio = this._limpiarNombre(nombre);
    const registro = await this._leerRegistro(projectId);
    if (!registro[limpio]) throw new Error('ATTACHMENT_NOT_FOUND');
    const origen = path.join(this._dir(projectId), limpio);
    const stats = await fs.stat(origen).catch(() => null);
    if (!stats || !stats.isFile()) throw new Error('ATTACHMENT_FILE_MISSING');
    const destinoDir = this._resolverDestino(projectId, destino);
    await fs.mkdir(destinoDir, { recursive: true });
    const destinoFinal = path.join(destinoDir, limpio);
    await fs.rename(origen, destinoFinal);
    delete registro[limpio];
    await this._escribirRegistro(projectId, registro);
    const rel = path.relative(this._projectDir(projectId), destinoFinal).split(path.sep).join('/');
    await this._registrar(projectId, { accion: 'movido', nombre: limpio, destino: rel });
    return { nombre: limpio, destino: rel };
  }

  async detach(projectId, nombre) {
    const limpio = this._limpiarNombre(nombre);
    const registro = await this._leerRegistro(projectId);
    if (!registro[limpio]) throw new Error('ATTACHMENT_NOT_FOUND');
    delete registro[limpio];
    await this._escribirRegistro(projectId, registro);
    // El fichero NO se toca: se queda donde está; el proyecto lo olvida.
    await this._registrar(projectId, { accion: 'desasociado', nombre: limpio });
    return { nombre: limpio };
  }

  async remove(projectId, nombre) {
    const limpio = this._limpiarNombre(nombre);
    const registro = await this._leerRegistro(projectId);
    if (!registro[limpio]) throw new Error('ATTACHMENT_NOT_FOUND');
    const ruta = path.join(this._dir(projectId), limpio);
    await fs.rm(ruta, { force: true });
    delete registro[limpio];
    await this._escribirRegistro(projectId, registro);
    await this._registrar(projectId, { accion: 'borrado', nombre: limpio });
    return { nombre: limpio };
  }
}
