import fs from 'node:fs/promises';
import os from 'node:os';
import { SystemHealthPort } from '../../domain/ports/SystemHealthPort.js';

/**
 * Adaptador: LocalSystemHealthAdapter
 * ==================================================================
 * Lee la salud de la Raspberry sin dependencias ni root:
 *  - **Temperatura**: `/sys/class/thermal/thermal_zone0/temp` (miligrados).
 *    Si no existe (PC de desarrollo), se prueba `thermal_zone1` y, si no,
 *    se devuelve `null`.
 *  - **Disco**: `fs.statfs` sobre la raíz (o la ruta que se indique).
 *  - **Memoria**: `/proc/meminfo` (`MemTotal`, `MemAvailable`), con respaldo
 *    de `os.totalmem()/freemem()`.
 *  - **Carga** y **encendido**: `os.loadavg()`, `os.uptime()`.
 *
 * Todo es tolerante a fallos: si algo no se puede leer, va a `null` y la
 * interfaz muestra lo que sí haya.
 */
export class LocalSystemHealthAdapter extends SystemHealthPort {
  constructor({
    thermalPaths = [
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/thermal/thermal_zone1/temp'
    ],
    diskPath = '/',
    meminfoPath = '/proc/meminfo'
  } = {}) {
    super();
    this.thermalPaths = thermalPaths;
    this.diskPath = diskPath;
    this.meminfoPath = meminfoPath;
  }

  async _temperatura() {
    for (const ruta of this.thermalPaths) {
      try {
        const crudo = (await fs.readFile(ruta, 'utf8')).trim();
        const n = Number(crudo);
        if (!Number.isFinite(n) || n <= 0) continue;
        // sysfs la da en miligrados de grado.
        return n > 1000 ? Math.round(n / 100) / 10 : n;
      } catch { /* siguiente ruta */ }
    }
    return null;
  }

  async _disco() {
    try {
      const s = await fs.statfs(this.diskPath);
      const total = s.blocks * s.bsize;
      const libre = s.bavail * s.bsize;
      const usado = total - s.bfree * s.bsize;
      return {
        ruta: this.diskPath,
        total,
        libre,
        usado,
        porcentaje: total ? Math.round((usado / total) * 100) : 0
      };
    } catch {
      return null;
    }
  }

  async _memoria() {
    try {
      const raw = await fs.readFile(this.meminfoPath, 'utf8');
      const valor = (clave) => {
        const m = raw.match(new RegExp(`^${clave}:\\s+(\\d+)\\s*kB`, 'm'));
        return m ? Number(m[1]) * 1024 : null;
      };
      const total = valor('MemTotal');
      const libre = valor('MemAvailable') ?? valor('MemFree');
      if (total != null && libre != null) {
        return { total, libre, usada: total - libre, porcentaje: Math.round(((total - libre) / total) * 100) };
      }
    } catch { /* respaldo con os */ }
    const total = os.totalmem();
    const libre = os.freemem();
    return { total, libre, usada: total - libre, porcentaje: total ? Math.round(((total - libre) / total) * 100) : 0 };
  }

  async read() {
    const [temperaturaC, disco, memoria] = await Promise.all([
      this._temperatura(),
      this._disco(),
      this._memoria()
    ]);
    const carga = os.loadavg();
    return {
      temperaturaC,
      disco,
      memoria,
      carga: { uno: carga[0], cinco: carga[1], quince: carga[2], nucleos: os.cpus()?.length || 1 },
      uptimeS: Math.round(os.uptime()),
      leidoEn: new Date().toISOString()
    };
  }
}
