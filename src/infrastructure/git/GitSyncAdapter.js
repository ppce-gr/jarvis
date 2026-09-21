import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitSyncPort } from '../../domain/ports/GitSyncPort.js';

const execFileAsync = promisify(execFile);

/**
 * Adaptador de Infraestructura: GitSyncAdapter
 * Respaldo del workspace en Git. Pensado para la resiliencia de la SD:
 * un `commitAll()` periódico garantiza que la muerte de la tarjeta no
 * se lleve por delante ideas, código ni bitácoras.
 *
 * Se usa `execFile` (no `exec`) para evitar inyección de shell: los
 * argumentos viajan como lista, nunca como cadena interpretada.
 */
export class GitSyncAdapter extends GitSyncPort {
  constructor(workspaceRoot = process.cwd()) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  async _git(args) {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.workspaceRoot,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  }

  async isRepository() {
    try {
      await this._git(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    if (!(await this.isRepository())) {
      return { isRepository: false, dirty: false, files: [] };
    }
    const porcelain = await this._git(['status', '--porcelain']);
    const files = porcelain ? porcelain.split('\n').filter(Boolean) : [];
    return {
      isRepository: true,
      dirty: files.length > 0,
      files,
      branch: await this._git(['rev-parse', '--abbrev-ref', 'HEAD'])
    };
  }

  async commitAll(message = 'chore(jarvis): autosave') {
    if (!(await this.isRepository())) {
      throw new Error('NOT_A_GIT_REPOSITORY');
    }

    await this._git(['add', '-A']);

    const staged = await this._git(['diff', '--cached', '--name-only']);
    if (!staged) {
      return { committed: false, reason: 'NOTHING_TO_COMMIT' };
    }

    await this._git(['commit', '-m', message]);
    return { committed: true, sha: await this._git(['rev-parse', '--short', 'HEAD']) };
  }

  async push(remote = 'origin', branch = 'main') {
    if (!(await this.isRepository())) {
      throw new Error('NOT_A_GIT_REPOSITORY');
    }
    try {
      await this._git(['push', remote, branch]);
      return { pushed: true, remote, branch };
    } catch (error) {
      return { pushed: false, error: error.message };
    }
  }

  async remotes() {
    if (!(await this.isRepository())) return [];
    const raw = await this._git(['remote', '-v']);
    if (!raw) return [];
    return raw.split('\n').map((line) => line.split(/\s+/)[0]);
  }
}
