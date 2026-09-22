import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SystemUpdatePort } from '../../domain/ports/SystemUpdatePort.js';

const execFileAsync = promisify(execFile);

/**
 * Adaptador de Infraestructura: LocalSystemUpdateAdapter
 * ------------------------------------------------------------------
 * Lee el estado del repositorio de código y deja la bandera que systemd vigila.
 *
 * Reparto de responsabilidades deliberado:
 *   · Jarvis (aquí)  → consulta el estado y PIDE la actualización.
 *   · systemd (fuera) → ejecuta `jarvis-actualizar`, que hace el trabajo sucio,
 *                       reinicia el servicio y revierte si algo falla.
 *
 * Así Jarvis no necesita privilegios de root ni puede dejar el sistema a medias.
 *
 * Se usa `execFile` (no `exec`) para que ningún argumento pase por un shell.
 */
export class LocalSystemUpdateAdapter extends SystemUpdatePort {
  constructor({
    codeDir = process.cwd(),
    stateDir = path.resolve(process.cwd(), '..', '.update-state'),
    flagFile = path.resolve(process.cwd(), '..', '.update-request'),
    branch = 'main'
  } = {}) {
    super();
    this.codeDir = codeDir;
    this.stateDir = stateDir;
    this.flagFile = flagFile;
    this.branch = branch;
    // El commit que este PROCESO cargó al arrancar. Ojo: no es lo mismo que el
    // HEAD del repositorio. Como el código vive en el mismo directorio que se
    // versiona, un commit nuevo cambia HEAD al instante, pero el proceso sigue
    // ejecutando lo que leyó al arrancar. Sin esta distinción, la interfaz
    // diría que corre una versión que en realidad no está en memoria.
    this.runningCommit = null;
  }

  /** Se llama una vez al arrancar: fija la versión que realmente se ejecuta. */
  async captureRunningCommit() {
    try {
      this.runningCommit = await this._git(['rev-parse', 'HEAD']);
    } catch {
      this.runningCommit = null;
    }
    return this.runningCommit;
  }

  async _git(args) {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.codeDir,
      maxBuffer: 512 * 1024
    });
    return stdout.trim();
  }

  async _leerFichero(file) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  async getStatus() {
    const estado = {
      commit: null,
      commitCorto: null,
      runningCommit: this.runningCommit,
      runningCommitCorto: this.runningCommit ? this.runningCommit.slice(0, 7) : null,
      reinicioPendiente: false,
      branch: this.branch,
      dirty: false,
      lastGood: null,
      lastGoodCorto: null,
      updateRequested: false,
      lastRun: null,
      canUpdate: false
    };

    try {
      estado.commit = await this._git(['rev-parse', 'HEAD']);
      estado.commitCorto = estado.commit.slice(0, 7);
      estado.branch = await this._git(['rev-parse', '--abbrev-ref', 'HEAD']);
      estado.dirty = (await this._git(['status', '--porcelain'])) !== '';
    } catch (error) {
      estado.error = error.message;
      return estado;
    }

    const lastGood = (await this._leerFichero(path.join(this.stateDir, 'last-good')))?.trim();
    if (lastGood) {
      estado.lastGood = lastGood;
      estado.lastGoodCorto = lastGood.slice(0, 7);
    }

    try {
      await fs.access(this.flagFile);
      estado.updateRequested = true;
    } catch {
      estado.updateRequested = false;
    }

    // Últimas líneas del registro del actualizador: es lo que le dice al
    // usuario si la última actualización fue bien o se revirtió.
    const log = await this._leerFichero(path.join(this.stateDir, 'autoactualizacion.log'));
    if (log) {
      estado.lastRun = log.trimEnd().split('\n').slice(-12).join('\n');
    }

    // Si el repositorio va por delante de lo que corre el proceso, hay un
    // reinicio pendiente: alguien ha traído código nuevo y aún no se aplicó.
    estado.reinicioPendiente = Boolean(
      this.runningCommit && estado.commit && this.runningCommit !== estado.commit
    );

    // Sólo se puede actualizar con el árbol limpio: es la primera barrera del
    // actualizador, así que conviene saberlo antes de pedirlo.
    estado.canUpdate = !estado.dirty;
    return estado;
  }

  /**
   * Deja la bandera. systemd la detecta y lanza el servicio de actualización.
   * Escribir un fichero no necesita privilegios: por eso el disparo es seguro.
   */
  async requestUpdate() {
    const estado = await this.getStatus();
    if (estado.dirty) {
      throw new Error('WORKING_TREE_DIRTY: hay cambios sin commitear; el actualizador se negaría por seguridad');
    }
    await fs.mkdir(path.dirname(this.flagFile), { recursive: true });
    // Se retira una bandera vieja primero: `PathExists` sólo dispara cuando el
    // fichero aparece, así que un resto de un intento anterior dejaría la
    // petición sin efecto.
    await fs.rm(this.flagFile, { force: true });
    await fs.writeFile(
      this.flagFile,
      JSON.stringify({ requestedAt: new Date().toISOString() }, null, 2)
    );
    return { requested: true, at: new Date().toISOString() };
  }

  /** Sólo consulta: trae las referencias del remoto y compara. No aplica nada. */
  async checkForUpdates() {
    const actual = await this._git(['rev-parse', 'HEAD']);

    try {
      await this._git(['fetch', 'origin', this.branch]);
    } catch (error) {
      return { actual: actual.slice(0, 7), error: `sin conexión con el remoto: ${error.message}` };
    }

    const remoto = await this._git(['rev-parse', `origin/${this.branch}`]);

    // Hay TRES relaciones posibles entre lo local y el remoto, no dos. Tratar
    // "local por delante" como una divergencia fue un fallo real: en cuanto se
    // commiteaba desde esta máquina —justo lo que hace la automodificación— la
    // actualización se bloqueaba para siempre, y como el aborto ocurría ANTES
    // del respaldo, esos commits tampoco se subían nunca.
    const esAncestro = async (a, b) => {
      try {
        await this._git(['merge-base', '--is-ancestor', a, b]);
        return true;
      } catch {
        return false;
      }
    };

    let relacion;
    if (actual === remoto) relacion = 'igual';
    else if (await esAncestro(actual, remoto)) relacion = 'detras';
    else if (await esAncestro(remoto, actual)) relacion = 'delante';
    else relacion = 'divergido';

    // Commits locales que el remoto todavía no tiene. En "delante" es trabajo
    // real pendiente de respaldar; en "divergido" es la mitad del problema.
    let pendienteDeSubir = 0;
    if (relacion === 'delante' || relacion === 'divergido') {
      const cuenta = await this._git(['rev-list', '--count', `origin/${this.branch}..HEAD`]);
      pendienteDeSubir = Number.parseInt(String(cuenta).trim(), 10) || 0;
    }

    return {
      actual: actual.slice(0, 7),
      remoto: remoto.slice(0, 7),
      relacion,
      // "Novedades" es lo que trae el REMOTO. En una divergencia de verdad
      // también las hay: hay commits remotos que aquí no están.
      hayNovedades: relacion === 'detras' || relacion === 'divergido',
      fastForward: relacion === 'detras',
      pendienteDeSubir,
      aviso: relacion === 'divergido'
        ? 'las ramas han divergido de verdad: hay commits en local y en el remoto que no están en el otro'
        : null
    };
  }
}
