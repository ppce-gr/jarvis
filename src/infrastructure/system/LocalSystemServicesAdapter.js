import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { SystemServicesPort } from '../../domain/ports/SystemServicesPort.js';

/**
 * Adaptador: LocalSystemServicesAdapter
 * ==================================================================
 * Puente entre la app y la herramienta `code/voz/servicios.py` del proyecto
 * "sistema-jarvis-parlante". Esa herramienta conoce el estado real de cada
 * capacidad (banderas de control + systemd) y las enciende/apaga sin root.
 *
 * - `python3` (biblioteca estándar) es suficiente: cero dependencias nuevas.
 * - Timeout generoso pero acotado: mejor un error claro que una UI colgada.
 */
export class LocalSystemServicesAdapter extends SystemServicesPort {
  constructor({ scriptPath, pythonBin = process.env.JARVIS_PYTHON || 'python3', timeoutMs = 15000 } = {}) {
    super();
    this.scriptPath = scriptPath;
    this.pythonBin = pythonBin;
    this.timeoutMs = timeoutMs;
  }

  get disponible() {
    return Boolean(this.scriptPath) && fs.existsSync(this.scriptPath);
  }

  _run(args) {
    return new Promise((resolve, reject) => {
      if (!this.disponible) {
        reject(new Error('La herramienta de servicios aún no está instalada.'));
        return;
      }
      let hijo;
      try {
        hijo = spawn(this.pythonBin, [this.scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);
        return;
      }
      let out = '';
      let err = '';
      const reloj = setTimeout(() => {
        try { hijo.kill('SIGKILL'); } catch { /* ya murió */ }
        reject(new Error('La operación de servicios tardó demasiado.'));
      }, this.timeoutMs);
      hijo.stdout.on('data', (d) => { out += d; });
      hijo.stderr.on('data', (d) => { err += d; });
      hijo.on('error', (error) => { clearTimeout(reloj); reject(error); });
      hijo.on('close', (codigo) => {
        clearTimeout(reloj);
        if (codigo !== 0) {
          reject(new Error(err.trim() || `servicios.py terminó con código ${codigo}`));
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error('La respuesta de servicios.py no es JSON válido.'));
        }
      });
    });
  }

  async list() {
    return await this._run(['--json']);
  }

  async toggle(id, action) {
    if (!id) throw new Error('SERVICE_ID_REQUIRED');
    const accion = action === 'desactivar' ? 'desactivar' : 'activar';
    return await this._run([accion, String(id), '--json']);
  }
}
