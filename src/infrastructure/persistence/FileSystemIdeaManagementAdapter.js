import fs from 'node:fs/promises';
import path from 'node:path';
import { IdeaManagementPort } from '../../domain/ports/IdeaManagementPort.js';

/**
 * Adaptador: FileSystemIdeaManagementAdapter
 * ==================================================================
 * Gestiona ideas sobre la memoria en disco:
 *  - **Duplicar**: copia completa de la carpeta de la idea.
 *  - **Renombrar**: mueve la carpeta (cambia el id).
 *  - **Borrar**: la manda a `<memoria>/.papelera/` (recuperable).
 *  - **Fusionar**: vuelca una idea en otra (notas renombrando colisiones y,
 *    si las dos traen código, encapsula cada código en su subcarpeta).
 *  - **Jerarquía**: un `padre` por idea en `<memoria>/.ideas.json`.
 *  - **Linaje**: cada operación queda en `<memoria>/.linaje.jsonl`.
 *
 * Protección: una idea con `workspace.json` (como `automodificacion`, cuyo
 * trabajo vive en el repositorio del código) es un proyecto especial: no se
 * renombra, ni se borra, ni se fusiona.
 */
export class FileSystemIdeaManagementAdapter extends IdeaManagementPort {
  static IDEAS = '.ideas.json';
  static LINAJE = '.linaje.jsonl';
  static PAPELERA = '.papelera';
  static REGISTRO = '.registro.json';

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  _dir(projectId) { return path.join(this.brainDir, projectId); }
  _metaPath() { return path.join(this.brainDir, FileSystemIdeaManagementAdapter.IDEAS); }
  _linajePath() { return path.join(this.brainDir, FileSystemIdeaManagementAdapter.LINAJE); }
  _papeleraPath() { return path.join(this.brainDir, FileSystemIdeaManagementAdapter.PAPELERA); }
  _registroPath() { return path.join(this._papeleraPath(), FileSystemIdeaManagementAdapter.REGISTRO); }


  _slug(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  async _existe(p) {
    try { await fs.stat(p); return true; } catch { return false; }
  }

  async _esProtegido(projectId) {
    return this._existe(path.join(this._dir(projectId), 'workspace.json'));
  }

  async _hijos(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => !e.name.startsWith('.')).map((e) => e.name);
    } catch { return []; }
  }

  /** Copia recursiva de un árbol (sin `.git`). */
  async _copiarArbol(src, dst) {
    const stats = await fs.stat(src).catch(() => null);
    if (!stats) return;
    if (stats.isDirectory()) {
      await fs.mkdir(dst, { recursive: true });
      for (const e of await fs.readdir(src, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        await this._copiarArbol(path.join(src, e.name), path.join(dst, e.name));
      }
    } else if (stats.isFile()) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    }
  }

  /** Copia un directorio renombrando los ficheros que ya existan (`nota-2.md`). */
  async _copiarRenombrando(srcDir, dstDir) {
    let entries = [];
    try { entries = await fs.readdir(srcDir, { withFileTypes: true }); } catch { return []; }
    await fs.mkdir(dstDir, { recursive: true });
    const copiados = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const src = path.join(srcDir, e.name);
      if (e.isDirectory()) {
        await this._copiarArbol(src, path.join(dstDir, e.name));
        copiados.push(e.name);
        continue;
      }
      const ext = path.extname(e.name);
      const base = path.basename(e.name, ext);
      let nombre = e.name;
      let n = 1;
      while (await this._existe(path.join(dstDir, nombre))) {
        n += 1;
        nombre = `${base}-${n}${ext}`;
      }
      await fs.copyFile(src, path.join(dstDir, nombre));
      copiados.push(nombre);
    }
    return copiados;
  }

  async _leerMeta() {
    try {
      const datos = JSON.parse(await fs.readFile(this._metaPath(), 'utf8'));
      return { padres: (datos && typeof datos.padres === 'object' && datos.padres) || {} };
    } catch { return { padres: {} }; }
  }

  async _escribirMeta(meta) {
    await fs.mkdir(this.brainDir, { recursive: true });
    await fs.writeFile(this._metaPath(), JSON.stringify({ padres: meta.padres || {} }, null, 2), 'utf8');
  }

  async _linaje(entrada) {
    await fs.mkdir(this.brainDir, { recursive: true });
    await fs.appendFile(this._linajePath(), `${JSON.stringify({ ...entrada, at: new Date().toISOString() })}\n`, 'utf8');
  }

  async _leerLinaje() {
    try {
      const raw = await fs.readFile(this._linajePath(), 'utf8');
      return raw.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).slice(-500);
    } catch { return []; }
  }

  async meta() {
    const m = await this._leerMeta();
    return { padres: m.padres, linaje: await this._leerLinaje() };
  }

  /* ------------------------------------------------------------------
   * Papelera: registro lateral
   * ------------------------------------------------------------------
   * El nombre de la carpeta en `.papelera/` ya lleva el id y la fecha, pero
   * no el padre: al borrar, los hijos se reparentan y esa información se
   * perdía. Este registro la guarda para poder DEVOLVER la idea a su sitio.
   * Un `ref` es el nombre de la carpeta dentro de `.papelera/`.
   */
  async _leerRegistro() {
    try {
      const datos = JSON.parse(await fs.readFile(this._registroPath(), 'utf8'));
      return (datos && typeof datos === 'object' && datos.entradas) || {};
    } catch { return {}; }
  }

  async _escribirRegistro(entradas) {
    await fs.mkdir(this._papeleraPath(), { recursive: true });
    await fs.writeFile(this._registroPath(), JSON.stringify({ entradas }, null, 2), 'utf8');
  }

  /** Un `ref` nunca puede salirse de `.papelera/`. */
  _refSeguro(ref) {
    const base = String(ref || '').trim();
    if (!base || base !== path.basename(base) || base === '.' || base === '..') {
      throw new Error('TRASH_REF_INVALID');
    }
    return base;
  }

  /** Lista lo que hay en la papelera, con su origen, padre y fecha. */
  async listTrash() {
    const papelera = this._papeleraPath();
    let entries = [];
    try {
      entries = await fs.readdir(papelera, { withFileTypes: true });
    } catch { return []; }
    const registro = await this._leerRegistro();
    const items = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const ref = e.name;
      const info = registro[ref] || {};
      const st = await fs.stat(path.join(papelera, ref)).catch(() => null);
      // De un registro antiguo o ausente, el id se deduce del nombre.
      const idea = info.idea || ref.split('__')[0];
      items.push({
        ref,
        idea,
        padre: info.padre || null,
        motivo: info.motivo || 'borrada',
        borradaEn: info.borradaEn || st?.mtime?.toISOString?.() || null
      });
    }
    items.sort((a, b) => String(b.borradaEn || '').localeCompare(String(a.borradaEn || '')));
    return items;
  }

  /**
   * Devuelve una idea de la papelera al catálogo. Si su id original ya está
   * ocupado, se recupera con un sufijo (`idea-2`, `idea-3`…) en vez de
   * pisar la que existe.
   */
  async restore(ref) {
    const base = this._refSeguro(ref);
    const papelera = this._papeleraPath();
    const origen = path.join(papelera, base);
    if (!(await this._existe(origen))) throw new Error('TRASH_ITEM_NOT_FOUND');

    const registro = await this._leerRegistro();
    const info = registro[base] || {};
    const idOriginal = this._slug(info.idea || base.split('__')[0]) || 'idea';

    let destinoId = idOriginal;
    let n = 1;
    while (await this._existe(this._dir(destinoId))) {
      n += 1;
      destinoId = `${idOriginal}-${n}`;
    }

    await fs.rename(origen, this._dir(destinoId));

    // Se devuelve a su padre si sigue existiendo; si no, al primer nivel.
    const meta = await this._leerMeta();
    const padre = info.padre ? String(info.padre) : null;
    meta.padres[destinoId] = (padre && padre !== destinoId && await this._existe(this._dir(padre)))
      ? padre
      : null;
    await this._escribirMeta(meta);

    delete registro[base];
    await this._escribirRegistro(registro);
    await this._linaje({
      accion: 'restaurada',
      idea: destinoId,
      de: base,
      renombrada: destinoId === idOriginal ? null : idOriginal
    });
    return { id: destinoId, de: base };
  }

  /** Borra definitivamente un elemento de la papelera (sin vuelta atrás). */
  async purge(ref) {
    const base = this._refSeguro(ref);
    const origen = path.join(this._papeleraPath(), base);
    if (!(await this._existe(origen))) throw new Error('TRASH_ITEM_NOT_FOUND');
    const registro = await this._leerRegistro();
    const idea = (registro[base] && registro[base].idea) || base.split('__')[0];
    await fs.rm(origen, { recursive: true, force: true });
    delete registro[base];
    await this._escribirRegistro(registro);
    await this._linaje({ accion: 'purgada', idea, de: base });
    return { de: base };
  }

  async setParent(projectId, padre) {
    if (!(await this._existe(this._dir(projectId)))) throw new Error('PROJECT_NOT_FOUND');
    const meta = await this._leerMeta();
    if (padre) {
      if (padre === projectId) throw new Error('PARENT_CYCLE');
      if (!(await this._existe(this._dir(padre)))) throw new Error('PARENT_NOT_FOUND');
      let actual = padre;
      const vistos = new Set();
      while (actual && !vistos.has(actual)) {
        if (actual === projectId) throw new Error('PARENT_CYCLE');
        vistos.add(actual);
        actual = meta.padres[actual] ?? null;
      }
      meta.padres[projectId] = padre;
    } else {
      meta.padres[projectId] = null;
    }
    await this._escribirMeta(meta);
    await this._linaje({ accion: padre ? 'agrupada' : 'desagrupada', idea: projectId, padre: padre || null });
    return { id: projectId, padre: meta.padres[projectId] };
  }

  async duplicate(projectId, nuevoId) {
    const destinoId = this._slug(nuevoId);
    if (!destinoId) throw new Error('PROJECT_ID_REQUIRED');
    if (!(await this._existe(this._dir(projectId)))) throw new Error('PROJECT_NOT_FOUND');
    if (await this._esProtegido(projectId)) throw new Error('PROJECT_PROTECTED');
    if (await this._existe(this._dir(destinoId))) throw new Error('PROJECT_ALREADY_EXISTS');
    await this._copiarArbol(this._dir(projectId), this._dir(destinoId));
    const meta = await this._leerMeta();
    meta.padres[destinoId] = meta.padres[projectId] ?? null;
    await this._escribirMeta(meta);
    await this._linaje({ accion: 'duplicada', idea: destinoId, de: projectId });
    return { id: destinoId, de: projectId };
  }

  async rename(projectId, nuevoId) {
    const destinoId = this._slug(nuevoId);
    if (!destinoId) throw new Error('PROJECT_ID_REQUIRED');
    if (!(await this._existe(this._dir(projectId)))) throw new Error('PROJECT_NOT_FOUND');
    if (await this._esProtegido(projectId)) throw new Error('PROJECT_PROTECTED');
    if (await this._existe(this._dir(destinoId))) throw new Error('PROJECT_ALREADY_EXISTS');
    await fs.rename(this._dir(projectId), this._dir(destinoId));
    const meta = await this._leerMeta();
    meta.padres[destinoId] = meta.padres[projectId] ?? null;
    delete meta.padres[projectId];
    for (const [hijo, padre] of Object.entries(meta.padres)) {
      if (padre === projectId) meta.padres[hijo] = destinoId;
    }
    await this._escribirMeta(meta);
    await this._linaje({ accion: 'renombrada', idea: destinoId, de: projectId });
    return { id: destinoId, de: projectId };
  }

  async trash(projectId) {
    if (!(await this._existe(this._dir(projectId)))) throw new Error('PROJECT_NOT_FOUND');
    if (await this._esProtegido(projectId)) throw new Error('PROJECT_PROTECTED');
    const papelera = this._papeleraPath();
    await fs.mkdir(papelera, { recursive: true });
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    const destino = path.join(papelera, `${projectId}__${marca}`);
    await fs.rename(this._dir(projectId), destino);
    const meta = await this._leerMeta();
    const padreOriginal = meta.padres[projectId] ?? null;
    delete meta.padres[projectId];
    for (const [hijo, padre] of Object.entries(meta.padres)) {
      if (padre === projectId) meta.padres[hijo] = padreOriginal;
    }
    await this._escribirMeta(meta);
    // El padre se guarda en el registro: al restaurar, la idea vuelve a su
    // sitio. El linaje es un diario para leer; el registro, datos para actuar.
    const registro = await this._leerRegistro();
    registro[path.basename(destino)] = {
      idea: projectId,
      padre: padreOriginal,
      motivo: 'borrada',
      borradaEn: new Date().toISOString()
    };
    await this._escribirRegistro(registro);
    await this._linaje({ accion: 'borrada', idea: projectId, papelera: path.basename(destino) });
    return { id: projectId, papelera: `papelera/${path.basename(destino)}` };
  }

  async merge(origenId, destinoId) {
    if (!origenId || !destinoId) throw new Error('PROJECT_ID_REQUIRED');
    if (origenId === destinoId) throw new Error('MERGE_SAME_PROJECT');
    if (!(await this._existe(this._dir(origenId)))) throw new Error('PROJECT_NOT_FOUND');
    if (!(await this._existe(this._dir(destinoId)))) throw new Error('PROJECT_NOT_FOUND');
    if (await this._esProtegido(origenId) || await this._esProtegido(destinoId)) {
      throw new Error('PROJECT_PROTECTED');
    }

    // Notas, adjuntos y bitácoras: se copian renombrando lo que choque.
    await this._copiarRenombrando(path.join(this._dir(origenId), 'conceptual'), path.join(this._dir(destinoId), 'conceptual'));
    await this._copiarRenombrando(path.join(this._dir(origenId), 'adjuntos'), path.join(this._dir(destinoId), 'adjuntos'));
    await this._copiarRenombrando(path.join(this._dir(origenId), 'logs'), path.join(this._dir(destinoId), 'logs'));

    // Código: si las DOS traen aplicaciones, cada una en su subcarpeta.
    const codeDestino = await this._hijos(path.join(this._dir(destinoId), 'code'));
    const codeOrigen = await this._hijos(path.join(this._dir(origenId), 'code'));
    if (codeOrigen.length && codeDestino.length) {
      const subDestino = path.join(this._dir(destinoId), 'code', destinoId);
      await fs.mkdir(subDestino, { recursive: true });
      for (const nombre of codeDestino) {
        await fs.rename(path.join(this._dir(destinoId), 'code', nombre), path.join(subDestino, nombre)).catch(() => {});
      }
      await this._copiarArbol(path.join(this._dir(origenId), 'code'), path.join(this._dir(destinoId), 'code', origenId));
    } else if (codeOrigen.length) {
      await this._copiarRenombrando(path.join(this._dir(origenId), 'code'), path.join(this._dir(destinoId), 'code'));
    }

    await this.trash(origenId);
    await this._linaje({ accion: 'fusionada', idea: destinoId, de: origenId });
    return { id: destinoId, de: origenId };
  }
}
