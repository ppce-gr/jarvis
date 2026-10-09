import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { PermissionPort } from '../../domain/ports/PermissionPort.js';

/**
 * Adaptador: FileSystemPermissionAdapter
 * ==================================================================
 * El agente **pide**, el usuario **aprueba una a una** con su PIN y un
 * **helper de root** ejecuta. Aquí se guarda la cola:
 *
 *   <idea>/logs/permisos/pendientes/<id>.json
 *   <idea>/logs/permisos/resultados/<id>.json
 *
 * El PIN **no se guarda aquí**: viaja por `stdin` al helper, que lo verifica
 * contra un hash propiedad de root. Este adaptador jamás ejecuta nada por su
 * cuenta: solo escribe peticiones y lanza al helper con `sudo -n`.
 */
export class FileSystemPermissionAdapter extends PermissionPort {
  static MAX_COMANDO = 2000;
  static MAX_RESULTADOS = 40;

  constructor({ brainDir, helperBin = '/usr/local/sbin/jarvis-permiso', spawnFn = nodeSpawn } = {}) {
    super();
    this.brainDir = brainDir;
    this.helperBin = helperBin;
    this.spawnFn = spawnFn;
  }

  _dir(projectId) { return path.join(this.brainDir, projectId, 'logs', 'permisos'); }
  _pendientes(projectId) { return path.join(this._dir(projectId), 'pendientes'); }
  _resultados(projectId) { return path.join(this._dir(projectId), 'resultados'); }

  _nuevoId() {
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    return `${marca}-${crypto.randomBytes(4).toString('hex')}`;
  }

  _seguro(id) {
    const base = String(id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(base)) throw new Error('PERMISSION_ID_INVALID');
    return base;
  }

  async _leerJson(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
  }

  async list(projectId) {
    const pendientes = [];
    const resultados = [];
    for (const [sub, destino] of [['pendientes', pendientes], ['resultados', resultados]]) {
      let entries = [];
      try { entries = await fs.readdir(path.join(this._dir(projectId), sub)); } catch { /* sin carpeta */ }
      for (const nombre of entries) {
        if (!nombre.endsWith('.json')) continue;
        const datos = await this._leerJson(path.join(this._dir(projectId), sub, nombre));
        if (datos) destino.push(datos);
      }
    }
    pendientes.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    resultados.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return { pendientes, resultados: resultados.slice(0, FileSystemPermissionAdapter.MAX_RESULTADOS) };
  }

  async request(projectId, comando, motivo = '', cwd = '') {
    const cmd = String(comando || '').trim();
    if (!cmd) throw new Error('PERMISSION_COMMAND_REQUIRED');
    if (cmd.length > FileSystemPermissionAdapter.MAX_COMANDO) throw new Error('PERMISSION_COMMAND_TOO_LONG');
    const id = this._nuevoId();
    const entrada = {
      id,
      comando: cmd,
      motivo: String(motivo || '').slice(0, 500),
      cwd: String(cwd || '').trim(),
      projectId,
      estado: 'pendiente',
      at: new Date().toISOString()
    };
    await fs.mkdir(this._pendientes(projectId), { recursive: true });
    await fs.writeFile(
      path.join(this._pendientes(projectId), `${id}.json`),
      JSON.stringify(entrada, null, 2),
      'utf8'
    );
    return entrada;
  }

  /**
   * Aprueba y ejecuta: el PIN va por stdin al helper, que lo verifica y corre
   * el comando de la petición. Si el helper no deja resultado, es que falló.
   */
  async approve(projectId, id, pin) {
    const seguro = this._seguro(id);
    if (!pin) throw new Error('PERMISSION_PIN_REQUIRED');
    const pendiente = path.join(this._pendientes(projectId), `${seguro}.json`);
    if (!(await this._leerJson(pendiente))) throw new Error('PERMISSION_NOT_FOUND');

    const salida = await new Promise((resolve) => {
      let out = '';
      let err = '';
      let hijo;
      try {
        hijo = this.spawnFn('sudo', ['-n', this.helperBin, 'aprobar', pendiente], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        return resolve({ codigo: -1, out: '', err: error.message });
      }
      hijo.stdout.on('data', (d) => { out += d; });
      hijo.stderr.on('data', (d) => { err += d; });
      hijo.on('close', (codigo) => resolve({ codigo, out, err }));
      try {
        hijo.stdin.write(`${pin}\n`);
        hijo.stdin.end();
      } catch { /* el helper dirá qué pasó */ }
    });

    const resultado = await this._leerJson(path.join(this._resultados(projectId), `${seguro}.json`));
    if (!resultado) {
      throw new Error(salida.err.trim() || `El helper terminó con código ${salida.codigo}`);
    }
    return resultado;
  }

  async reject(projectId, id, motivo = '') {
    const seguro = this._seguro(id);
    const pendiente = path.join(this._pendientes(projectId), `${seguro}.json`);
    const entrada = await this._leerJson(pendiente);
    if (!entrada) throw new Error('PERMISSION_NOT_FOUND');
    const resultado = {
      ...entrada,
      estado: 'rechazada',
      aprobado: false,
      salida: `Rechazada: ${motivo || 'sin motivo'}`,
      codigo: null,
      at: new Date().toISOString()
    };
    await fs.mkdir(this._resultados(projectId), { recursive: true });
    await fs.writeFile(
      path.join(this._resultados(projectId), `${seguro}.json`),
      JSON.stringify(resultado, null, 2),
      'utf8'
    );
    await fs.rm(pendiente, { force: true });
    return resultado;
  }
}
