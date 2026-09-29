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

  constructor(brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault')) {
    super();
    this.brainDir = brainDir;
  }

  _dir(projectId) { return path.join(this.brainDir, projectId); }
  _metaPath() { return path.join(this.brainDir, FileSystemIdeaManagementAdapter.IDEAS); }
  _linajePath() { return path.join(this.brainDir, FileSystemIdeaManagementAdapter.LINAJE); }

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
    const papelera = path.join(this.brainDir, FileSystemIdeaManagementAdapter.PAPELERA);
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
