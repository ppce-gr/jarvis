import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorPort } from '../../domain/ports/OrchestratorPort.js';

/**
 * Adaptador de Infraestructura: DshHeadlessOrchestratorAdapter
 * ------------------------------------------------------------------
 * Conecta Jarvis con DeepSeek Harness mediante su modo `headless`
 * (`dsh --profile headless "<tarea>"`), que:
 *   - abre un proceso nuevo por tarea,
 *   - NO abre puertos,
 *   - escribe el razonamiento en stderr y la respuesta final en stdout,
 *   - devuelve exit code 0 si completó y 1 si abortó.
 *
 * Medido en esta Raspberry Pi 3B: ~16-18 s de arranque por tarea y
 * ~168 MB de RSS pico. Consecuencias de diseño, no suposiciones:
 *
 *   1. COLA DE UNO: se ejecuta una sola tarea a la vez por proceso.
 *      Dos en paralelo (~336 MB) comprometerían la Pi de 1 GB.
 *   2. ASÍNCRONO: `executeTask` encola y devuelve acuse inmediato.
 *   3. BITÁCORA EN VIVO: el razonamiento se vuelca a
 *      `projects/<id>/logs/<taskId>.log` según llega, para que la
 *      interfaz muestre progreso real. Con tope de tamaño para no
 *      castigar la tarjeta SD.
 *
 * `runner` es inyectable para poder probar el adaptador sin lanzar
 * procesos reales ni gastar tokens.
 */
export class DshHeadlessOrchestratorAdapter extends OrchestratorPort {
  static MAX_LOG_BYTES = 1024 * 1024; // 1 MB por tarea: protección de la SD

  constructor({
    workspaceRoot = process.cwd(),
    dshBin = process.env.JARVIS_DSH_BIN || 'dsh',
    profile = process.env.JARVIS_DSH_PROFILE || 'headless',
    dshHome = process.env.DSH_HOME || undefined,
    timeoutMs = Number(process.env.JARVIS_TASK_TIMEOUT_MS || 15 * 60 * 1000),
    runner = null
  } = {}) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.dshBin = dshBin;
    this.profile = profile;
    this.dshHome = dshHome;
    this.timeoutMs = timeoutMs;
    this.runner = runner || DshHeadlessOrchestratorAdapter.spawnRunner;

    /** @type {Map<string, Array<object>>} projectId -> tareas */
    this.tasks = new Map();
    /** Cola global: garantiza una única tarea en vuelo en toda la Pi. */
    this._chain = Promise.resolve();
    this._counter = 0;
  }

  /* ------------------------------------------------------------------
   * Runner por defecto: lanza el proceso real.
   * ------------------------------------------------------------------ */
  static spawnRunner({ bin, args, cwd, env, timeoutMs, onStdout, onStderr }) {
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (onStdout) onStdout(text);
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (onStderr) onStderr(text);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        // ENOENT es el fallo más habitual en despliegue: el binario `dsh`
        // no está en el PATH del servicio. Damos una pista accionable.
        const hint = error.code === 'ENOENT'
          ? `No se encontró el binario "${bin}". Instálalo (npm install -g @deepseek-ai/dsh) o ajusta JARVIS_DSH_BIN.`
          : error.message;
        resolve({ code: -1, stdout, stderr: `${stderr}\n${hint}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }

  /* ------------------------------------------------------------------
   * Utilidades internas
   * ------------------------------------------------------------------ */
  _projectDir(projectId) {
    return path.join(this.workspaceRoot, 'projects', projectId);
  }

  _logsDir(projectId) {
    return path.join(this._projectDir(projectId), 'logs');
  }

  /**
   * Construye el enunciado que recibe DSH. El directorio de trabajo del
   * proceso es la carpeta del proyecto, así que el agente ve `conceptual/`
   * y escribe en `code/` sin que tengamos que explicarle rutas absolutas.
   */
  _buildPrompt(projectId, instruction) {
    return [
      `Trabajas dentro del proyecto "${projectId}" de Jarvis.`,
      'El directorio de trabajo actual ES la carpeta del proyecto.',
      '- Lee el contexto en `conceptual/` antes de actuar (sobre todo `_indice.md` y `qa-dudas.md`).',
      '- Escribe el código y los artefactos en `code/`.',
      '- No modifiques ficheros fuera de este proyecto.',
      '',
      'Orden del usuario:',
      instruction,
      '',
      'Al terminar, responde con un resumen breve y concreto de lo que has hecho.'
    ].join('\n');
  }

  static _slug(text, max = 40) {
    return String(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'tarea';
  }

  static _stamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /* ------------------------------------------------------------------
   * API pública del puerto
   * ------------------------------------------------------------------ */
  async executeTask(projectId, instruction) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    if (!instruction || !String(instruction).trim()) {
      throw new Error('INSTRUCTION_REQUIRED');
    }

    const taskId = `t${++this._counter}-${DshHeadlessOrchestratorAdapter._stamp()}-${DshHeadlessOrchestratorAdapter._slug(instruction)}`;
    const task = {
      taskId,
      projectId,
      instruction: instruction.trim(),
      status: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      logFile: `logs/${taskId}.log`,
      answer: null
    };

    if (!this.tasks.has(projectId)) this.tasks.set(projectId, []);
    this.tasks.get(projectId).unshift(task);

    // Encadenar: una tarea detrás de otra (cola de uno).
    this._chain = this._chain.then(() => this._run(task)).catch(() => {});

    return { accepted: true, taskId, status: task.status };
  }

  async listTasks(projectId) {
    return this.tasks.get(projectId) || [];
  }

  /* ------------------------------------------------------------------
   * Ejecución real de una tarea
   * ------------------------------------------------------------------ */
  async _run(task) {
    const logsDir = this._logsDir(task.projectId);
    await fs.mkdir(logsDir, { recursive: true });

    const logPath = path.join(this._projectDir(task.projectId), task.logFile);
    const summaryPath = path.join(logsDir, 'orchestrator.log');

    task.status = 'running';
    task.startedAt = new Date().toISOString();

    let written = 0;
    const appendLog = async (text, { count = true } = {}) => {
      if (count) {
        if (written >= DshHeadlessOrchestratorAdapter.MAX_LOG_BYTES) return;
        written += Buffer.byteLength(text);
      }
      try {
        await fs.appendFile(logPath, text, 'utf8');
      } catch { /* un fallo de bitácora no debe tumbar la tarea */ }
    };

    await appendLog(
      `# Tarea ${task.taskId}\n\n` +
      `- Proyecto: \`${task.projectId}\`\n` +
      `- Inicio: ${task.startedAt}\n` +
      `- Perfil DSH: \`${this.profile}\`\n\n` +
      `## Orden\n\n${task.instruction}\n\n## Razonamiento\n\n`
    );

    const env = { ...process.env };
    if (this.dshHome) env.DSH_HOME = this.dshHome;

    let result;
    try {
      result = await this.runner({
        bin: this.dshBin,
        args: ['--profile', this.profile, this._buildPrompt(task.projectId, task.instruction)],
        cwd: this._projectDir(task.projectId),
        env,
        timeoutMs: this.timeoutMs,
        onStderr: (text) => { appendLog(text); }
      });
    } catch (error) {
      result = { code: -1, stdout: '', stderr: error.message, timedOut: false };
    }

    task.exitCode = result.code;
    task.finishedAt = new Date().toISOString();
    task.answer = (result.stdout || '').trim();

    if (result.timedOut) {
      task.status = 'timeout';
    } else if (result.code === 0) {
      task.status = 'completed';
    } else {
      task.status = 'failed';
    }

    await appendLog(
      `\n\n## Respuesta final\n\n${task.answer || '(sin respuesta)'}\n\n` +
      `## Resultado\n\n- Estado: **${task.status}**\n- Exit code: ${result.code}\n- Fin: ${task.finishedAt}\n`
    );

    // Resumen compacto para la bitácora general (fácil de leer en el móvil).
    const summary =
      `[${task.finishedAt}] ${task.status.toUpperCase()} · ${task.projectId} · ${task.taskId}\n` +
      `  orden: ${task.instruction.slice(0, 160)}\n` +
      `  detalle: ${task.logFile}\n`;
    try {
      await fs.appendFile(summaryPath, summary, 'utf8');
    } catch { /* opcional */ }

    return task;
  }
}
