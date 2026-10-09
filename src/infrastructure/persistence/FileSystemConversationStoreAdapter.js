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
  static META = '.meta.json';
  static PAPELERA = '.papelera';
  static REGISTRO = '.registro.json';
  static MAX_BYTES = 4 * 1024 * 1024; // 4 MB por conversación

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  _logs(projectId) { return path.join(this.brainDir, projectId, 'logs'); }
  _actual(projectId) { return path.join(this._logs(projectId), FileSystemConversationStoreAdapter.ACTUAL); }
  _carpeta(projectId) { return path.join(this._logs(projectId), FileSystemConversationStoreAdapter.CARPETA); }
  _metaPath(projectId) { return path.join(this._carpeta(projectId), FileSystemConversationStoreAdapter.META); }
  _papelera(projectId) { return path.join(this._carpeta(projectId), FileSystemConversationStoreAdapter.PAPELERA); }
  _registroPath(projectId) { return path.join(this._papelera(projectId), FileSystemConversationStoreAdapter.REGISTRO); }

  /* ---- Títulos: fichero lateral, el .jsonl no se toca ---- */
  async _leerTitulos(projectId) {
    try {
      const datos = JSON.parse(await fs.readFile(this._metaPath(projectId), 'utf8'));
      return (datos && typeof datos === 'object' && datos.titulos) || {};
    } catch { return {}; }
  }

  async _escribirTitulos(projectId, titulos) {
    await fs.mkdir(this._carpeta(projectId), { recursive: true });
    await fs.writeFile(this._metaPath(projectId), JSON.stringify({ titulos }, null, 2), 'utf8');
  }

  async _leerRegistro(projectId) {
    try {
      const datos = JSON.parse(await fs.readFile(this._registroPath(projectId), 'utf8'));
      return (datos && typeof datos === 'object' && datos.entradas) || {};
    } catch { return {}; }
  }

  async _escribirRegistro(projectId, entradas) {
    await fs.mkdir(this._papelera(projectId), { recursive: true });
    await fs.writeFile(this._registroPath(projectId), JSON.stringify({ entradas }, null, 2), 'utf8');
  }

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

  /** Extracto reconocible de una conversación: primer mensaje y último. */
  _extracto(mensajes) {
    const limpio = (m) => String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const primero = mensajes.find((m) => m.role === 'user');
    const ultimo = [...mensajes].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
    return { inicio: limpio(primero), ultimo: limpio(ultimo) };
  }

  async list(projectId) {
    const actual = await this._leer(this._actual(projectId));
    const titulos = await this._leerTitulos(projectId);
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
        titulo: titulos[e.name] || null,
        mensajes: mensajes.length,
        modificadoEn: st?.mtime?.toISOString?.() || null,
        ...this._extracto(mensajes)
      });
    }
    archivadas.sort((a, b) => String(b.modificadoEn || '').localeCompare(String(a.modificadoEn || '')));
    return {
      actual: { nombre: 'actual', mensajes: actual.length, ...this._extracto(actual) },
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
    // Se MUEVE (no se copia): la elegida deja de estar archivada, así no sale
    // dos veces en la lista.
    await fs.rename(origen, this._actual(projectId));
    return { continuada: base, mensajes: mensajes.length };
  }

  /* ------------------------------------------------------------------
   * Título de una conversación guardada
   * ------------------------------------------------------------------
   * El nombre del fichero es la fecha (es lo que lo hace único); el título
   * es para el humano. Se guarda aparte para no reescribir el `.jsonl`.
   */
  async setTitle(projectId, nombre, titulo) {
    const base = this._nombreSeguro(nombre);
    if (!(await this._existeArchivada(projectId, base))) throw new Error('CONVERSATION_NOT_FOUND');
    const titulos = await this._leerTitulos(projectId);
    const limpio = String(titulo ?? '').trim().slice(0, 120);
    if (limpio) titulos[base] = limpio;
    else delete titulos[base];
    await this._escribirTitulos(projectId, titulos);
    return { nombre: base, titulo: limpio || null };
  }

  async _existeArchivada(projectId, base) {
    try { await fs.stat(path.join(this._carpeta(projectId), base)); return true; } catch { return false; }
  }

  /* ------------------------------------------------------------------
   * Papelera de conversaciones
   * ------------------------------------------------------------------
   * Borrar una guardada no la elimina: se mueve a `conversaciones/.papelera/`
   * con un nombre único y su registro, para poder recuperarla. Purgar sí la
   * borra del disco.
   */
  _refSeguro(ref) {
    const base = String(ref || '').trim();
    if (!base || base !== path.basename(base) || base === '.' || base === '..') {
      throw new Error('CONVERSATION_NAME_INVALID');
    }
    return base;
  }

  async remove(projectId, nombre) {
    const base = this._nombreSeguro(nombre);
    const ruta = path.join(this._carpeta(projectId), base);
    if (!(await this._existeArchivada(projectId, base))) throw new Error('CONVERSATION_NOT_FOUND');
    await fs.mkdir(this._papelera(projectId), { recursive: true });
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    const ref = `${base}__${marca}`;
    const titulos = await this._leerTitulos(projectId);
    const titulo = titulos[base] || null;
    await fs.rename(ruta, path.join(this._papelera(projectId), ref));

    delete titulos[base];
    await this._escribirTitulos(projectId, titulos);
    const registro = await this._leerRegistro(projectId);
    registro[ref] = { nombre: base, titulo, borradaEn: new Date().toISOString() };
    await this._escribirRegistro(projectId, registro);
    return { borrada: base, ref };
  }

  async listTrash(projectId) {
    let entries = [];
    try {
      entries = await fs.readdir(this._papelera(projectId), { withFileTypes: true });
    } catch { return []; }
    const registro = await this._leerRegistro(projectId);
    const items = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const ref = e.name;
      const info = registro[ref] || {};
      const st = await fs.stat(path.join(this._papelera(projectId), ref)).catch(() => null);
      items.push({
        ref,
        nombre: info.nombre || ref,
        titulo: info.titulo || null,
        borradaEn: info.borradaEn || st?.mtime?.toISOString?.() || null
      });
    }
    items.sort((a, b) => String(b.borradaEn || '').localeCompare(String(a.borradaEn || '')));
    return items;
  }

  async restoreTrash(projectId, ref) {
    const base = this._refSeguro(ref);
    const origen = path.join(this._papelera(projectId), base);
    if (!(await this._existe(origen))) throw new Error('CONVERSATION_NOT_FOUND');

    const registro = await this._leerRegistro(projectId);
    const info = registro[base] || {};
    const preferido = this._nombreSeguro(info.nombre || `${base.split('__')[0]}.jsonl`);

    // Si volviera a chocar (p. ej. se archivó otra con el mismo nombre), se
    // recupera con sufijo en vez de pisar.
    const ext = path.extname(preferido);
    const raiz = path.basename(preferido, ext);
    let nombre = preferido;
    let n = 1;
    while (await this._existeArchivada(projectId, nombre)) {
      n += 1;
      nombre = `${raiz}-${n}${ext}`;
    }

    await fs.mkdir(this._carpeta(projectId), { recursive: true });
    await fs.rename(origen, path.join(this._carpeta(projectId), nombre));
    delete registro[base];
    await this._escribirRegistro(projectId, registro);
    if (info.titulo) {
      const titulos = await this._leerTitulos(projectId);
      titulos[nombre] = info.titulo;
      await this._escribirTitulos(projectId, titulos);
    }
    return { restaurada: nombre, de: base };
  }

  async purgeTrash(projectId, ref) {
    const base = this._refSeguro(ref);
    const ruta = path.join(this._papelera(projectId), base);
    if (!(await this._existe(ruta))) throw new Error('CONVERSATION_NOT_FOUND');
    await fs.rm(ruta, { force: true });
    const registro = await this._leerRegistro(projectId);
    delete registro[base];
    await this._escribirRegistro(projectId, registro);
    return { purgada: base };
  }

  async _existe(p) {
    try { await fs.stat(p); return true; } catch { return false; }
  }
}
