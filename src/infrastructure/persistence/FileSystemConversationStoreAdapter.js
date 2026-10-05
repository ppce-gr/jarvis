import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationStorePort } from '../../domain/ports/ConversationStorePort.js';

/**
 * Adaptador: FileSystemConversationStoreAdapter
 * ==================================================================
 * La conversación **actual** de una idea vive en `logs/conversacion.jsonl`
 * (lo escribe el adaptador de chat). Aquí:
 *  - **Archivar**: mueve la actual a `logs/conversaciones/<fecha>.jsonl`.
 *  - **Listar**: la actual + las archivadas (con su nº de mensajes).
 *  - **Leer**: los mensajes de una.
 *  - **Restaurar**: archiva la actual y trae una archivada como actual, para
 *    continuarla (el adaptador de chat reinyecta luego los últimos mensajes).
 */
export class FileSystemConversationStoreAdapter extends ConversationStorePort {
  static ACTUAL = 'conversacion.jsonl';
  static CARPETA = 'conversaciones';
  static MAX_BYTES = 4 * 1024 * 1024; // 4 MB por conversación

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  _logs(projectId) { return path.join(this.brainDir, projectId, 'logs'); }
  _actual(projectId) { return path.join(this._logs(projectId), FileSystemConversationStoreAdapter.ACTUAL); }
  _carpeta(projectId) { return path.join(this._logs(projectId), FileSystemConversationStoreAdapter.CARPETA); }

  _nombreSeguro(nombre) {
    const original = String(nombre || '');
    if (original.includes('/') || original.includes('\\')) {
      throw new Error('CONVERSATION_NAME_INVALID');
    }
    const base = original.trim();
    if (!base || base.startsWith('.') || !base.endsWith('.jsonl')) {
      throw new Error('CONVERSATION_NAME_INVALID');
    }
    return base;
  }

  async _leer(file) {
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > FileSystemConversationStoreAdapter.MAX_BYTES) return [];
      const raw = await fs.readFile(file, 'utf8');
      return raw.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async list(projectId) {
    const actual = await this._leer(this._actual(projectId));
    const archivadas = [];
    let entries = [];
    try {
      entries = await fs.readdir(this._carpeta(projectId), { withFileTypes: true });
    } catch { /* sin carpeta todavía */ }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('.')) continue;
      const ruta = path.join(this._carpeta(projectId), e.name);
      const st = await fs.stat(ruta).catch(() => null);
      const mensajes = await this._leer(ruta);
      archivadas.push({
        nombre: e.name,
        mensajes: mensajes.length,
        modificadoEn: st?.mtime?.toISOString?.() || null
      });
    }
    archivadas.sort((a, b) => String(b.modificadoEn || '').localeCompare(String(a.modificadoEn || '')));
    return {
      actual: { nombre: 'actual', mensajes: actual.length },
      archivadas
    };
  }

  async read(projectId, nombre) {
    const file = (!nombre || nombre === 'actual')
      ? this._actual(projectId)
      : path.join(this._carpeta(projectId), this._nombreSeguro(nombre));
    return await this._leer(file);
  }

  async archive(projectId) {
    const actual = this._actual(projectId);
    const mensajes = await this._leer(actual);
    if (!mensajes.length) return { archivada: null, motivo: 'CONVERSACION_VACIA' };
    await fs.mkdir(this._carpeta(projectId), { recursive: true });
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    const destino = path.join(this._carpeta(projectId), `${marca}.jsonl`);
    await fs.rename(actual, destino);
    return { archivada: path.basename(destino), mensajes: mensajes.length };
  }

  async restore(projectId, nombre) {
    const base = this._nombreSeguro(nombre);
    const origen = path.join(this._carpeta(projectId), base);
    const mensajes = await this._leer(origen);
    if (!mensajes.length) throw new Error('CONVERSATION_NOT_FOUND');
    // Lo que hubiera en la actual no se tira: se archiva.
    await this.archive(projectId);
    await fs.mkdir(this._logs(projectId), { recursive: true });
    await fs.copyFile(origen, this._actual(projectId));
    return { continuada: base, mensajes: mensajes.length };
  }
}
