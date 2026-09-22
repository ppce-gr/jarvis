import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationPort } from '../../domain/ports/ConversationPort.js';
import { JsonRpcStdioClient } from './JsonRpcStdioClient.js';

/**
 * Adaptador de Infraestructura: DshSdkConversationAdapter
 * ==================================================================
 * Chat conversacional persistente sobre `dsh --profile sdk`, que sirve el
 * protocolo JSON-RPC de `@deepseek-ai/dsh-sdk-protocol` por stdio.
 *
 * POR QUÉ UN PROCESO POR PROYECTO
 *   El handshake `initialize` fija `cwd` para TODAS las sesiones que cree
 *   ese proceso (comprobado en `dsh-sdk-jsonrpc-server`: `meta: { cwd }`).
 *   Como queremos que el agente trabaje dentro de la carpeta del proyecto,
 *   hace falta un proceso por proyecto. Se arranca perezosamente (al primer
 *   mensaje) y se apaga solo tras un periodo de inactividad, para no tener
 *   procesos vivos consumiendo RAM en una Pi de 905 MB.
 *
 * LÍMITES REALES DEL PROTOCOLO (verificados en el código del servidor)
 *   - Sólo existen tres métodos: initialize, session/prompt, shutdown.
 *   - NO hay cancelación: no se puede abortar una respuesta en curso.
 *   - NO hay reanudación: `createSession` crea un agente NUEVO; no recarga
 *     el transcript persistido. La memoria del agente vive en el proceso.
 *   Consecuencias asumidas y documentadas:
 *     · La memoria del agente dura lo que dura el proceso. Por eso el
 *       contexto DURADERO vive en las notas de `conceptual/`, no en el chat,
 *       y por eso persistimos el transcript en disco para la interfaz.
 *     · `reset()` mata el proceso: sirve como "detener" cuando el agente se
 *       descarrila, a cambio de perder la memoria de lo hablado.
 *
 * EL PROGRESO ES POR PASOS, NO POR TOKENS
 *   Los eventos de sesión se registran al cerrar cada paso (`assistant/message`,
 *   `tool/call`, `turn/end`), no token a token. Para un asistente agéntico
 *   esto es útil: se ve qué HACE (lee un fichero, lanza tests) además de lo
 *   que dice.
 */
export class DshSdkConversationAdapter extends ConversationPort {
  static DEFAULT_IDLE_MS = 15 * 60 * 1000;

  constructor({
    brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault'),
    dshBin = process.env.JARVIS_DSH_BIN || 'dsh',
    profile = process.env.JARVIS_CHAT_PROFILE || 'sdk',
    dshHome = process.env.DSH_HOME || undefined,
    provider = process.env.JARVIS_CHAT_PROVIDER || 'deepseek-official',
    model = process.env.JARVIS_CHAT_MODEL || 'deepseek-v4-flash',
    reasoningEffort = process.env.JARVIS_CHAT_EFFORT || 'high',
    idleTimeoutMs = DshSdkConversationAdapter.DEFAULT_IDLE_MS,
    spawnFn = nodeSpawn
  } = {}) {
    super();
    this.brainDir = brainDir;
    this.dshBin = dshBin;
    this.profile = profile;
    this.dshHome = dshHome;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.idleTimeoutMs = idleTimeoutMs;
    this.spawnFn = spawnFn;

    /** @type {Map<string, object>} projectId -> sesión */
    this._sessions = new Map();
  }

  /* ------------------------------------------------------------------
   * Rutas
   * ------------------------------------------------------------------ */
  _projectDir(projectId) {
    return path.join(this.brainDir, projectId);
  }

  _transcriptPath(projectId) {
    return path.join(this._projectDir(projectId), 'logs', 'conversacion.jsonl');
  }

  /* ------------------------------------------------------------------
   * Sesión: arranque perezoso y apagado por inactividad
   * ------------------------------------------------------------------ */
  async _ensureSession(projectId) {
    const existing = this._sessions.get(projectId);
    // Un marcador (creado por `subscribe` antes del primer mensaje) tiene
    // listeners pero no proceso: hay que arrancar la sesión de verdad sin
    // perder a quien ya estaba escuchando.
    if (existing && !existing.dead && existing.rpc) {
      this._touch(existing);
      return existing;
    }
    const inheritedListeners = existing ? existing.listeners : new Set();

    const projectDir = this._projectDir(projectId);
    const sessionId = `jarvis-${projectId}`;

    const env = { ...process.env };
    if (this.dshHome) env.DSH_HOME = this.dshHome;

    const child = this.spawnFn(this.dshBin, ['--profile', this.profile], {
      cwd: projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const session = {
      projectId,
      sessionId,
      child,
      rpc: null,
      status: 'starting',
      busy: false,
      dead: false,
      listeners: inheritedListeners,
      lastActivity: Date.now(),
      idleTimer: null,
      stderrTail: [],
      turnCount: 0
    };

    const rpc = new JsonRpcStdioClient(child);
    session.rpc = rpc;

    // Diagnóstico: DSH reserva stdout para el protocolo y manda aquí lo demás.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      session.stderrTail.push(line);
      if (session.stderrTail.length > 20) session.stderrTail.shift();
      this._emit(projectId, { type: 'log', text: line });
    });

    rpc.on('notification', (method, params) => this._onNotification(session, method, params));

    rpc.on('close', () => {
      session.dead = true;
      session.busy = false;
      session.status = 'stopped';
      this._clearIdle(session);
      this._emit(projectId, { type: 'status', status: 'stopped' });
    });

    this._sessions.set(projectId, session);

    // Handshake: hasta que no responde, `session/prompt` es rechazado.
    try {
      await rpc.request('initialize', {
        cwd: projectDir,
        provider: this.provider,
        model: this.model,
        reasoningEffort: this.reasoningEffort || undefined
      });
      session.status = 'idle';
      this._emit(projectId, { type: 'status', status: 'idle' });
    } catch (error) {
      session.dead = true;
      this._clearIdle(session);
      const pista = session.stderrTail.slice(-5).join('\n');
      throw new Error(
        `No se pudo inicializar la conversación con DSH (${this.profile}): ${error.message}` +
        (pista ? `\nÚltimas líneas de DSH:\n${pista}` : '')
      );
    }

    return session;
  }

  _touch(session) {
    session.lastActivity = Date.now();
    this._clearIdle(session);
    if (this.idleTimeoutMs > 0) {
      session.idleTimer = setTimeout(() => {
        // Sólo se apaga si no hay trabajo en curso: cerrar a media respuesta
        // perdería la memoria del agente sin avisar.
        if (session.busy) {
          this._touch(session);
          return;
        }
        this._emit(session.projectId, {
          type: 'log',
          text: 'Conversación dormida por inactividad (se liberará la memoria del agente).'
        });
        this._kill(session);
      }, this.idleTimeoutMs);
      if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
    }
  }

  _clearIdle(session) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  _kill(session) {
    this._clearIdle(session);
    session.dead = true;
    session.status = 'stopped';
    try {
      session.child.kill('SIGTERM');
    } catch { /* ya muerto */ }
    this._emit(session.projectId, { type: 'status', status: 'stopped' });
  }

  /* ------------------------------------------------------------------
   * Eventos
   * ------------------------------------------------------------------ */
  _emit(projectId, event) {
    const session = this._sessions.get(projectId);
    if (!session) return;
    const enriched = { ...event, at: new Date().toISOString() };
    for (const listener of session.listeners) {
      try {
        listener(enriched);
      } catch { /* un observador roto no debe tumbar la conversación */ }
    }
  }

  _onNotification(session, method, params) {
    if (method === 'session.status') {
      if (params?.sessionId !== session.sessionId) return;
      session.status = params.status;              // 'idle' | 'running'
      session.busy = params.status === 'running';
      this._touch(session);
      this._emit(session.projectId, { type: 'status', status: params.status });
      return;
    }

    if (method !== 'session.event') return;
    if (params?.sessionId !== session.sessionId) return;

    const event = params.event;
    if (!event || typeof event.type !== 'string') return;
    this._touch(session);

    switch (event.type) {
      case 'assistant/message': {
        const text = DshSdkConversationAdapter.extractText(event.data?.message?.content);
        if (!text) return;
        this._record(session.projectId, { role: 'assistant', text, at: event.time });
        this._emit(session.projectId, { type: 'assistant', text });
        break;
      }
      case 'tool/call': {
        const name = event.data?.name || 'herramienta';
        this._record(session.projectId, { role: 'tool', text: name, at: event.time });
        this._emit(session.projectId, { type: 'tool-call', name });
        break;
      }
      case 'turn/end': {
        session.busy = false;
        this._emit(session.projectId, {
          type: 'turn-end',
          reason: event.data?.reason || 'unknown'
        });
        this._touch(session);
        break;
      }
      default:
        // El resto del vocabulario (todo/write, deliverables/presented,
        // subagentes…) no se pinta en el chat, pero queda en la sesión
        // persistida de DSH para quien quiera inspeccionarla.
        break;
    }
  }

  /** Extrae el texto visible de una lista de ContentBlock. */
  static extractText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /**
   * Envuelve el primer mensaje de cada sesión con el contexto del proyecto.
   *
   * Sólo el primero: repetirlo en cada turno sería ruido y gastaría tokens.
   * Si el proceso muere y se recrea la sesión, el contexto vuelve a inyectarse,
   * porque el agente nuevo no recuerda nada. El mensaje original del usuario es
   * el que se guarda en el transcript; esto es sólo lo que viaja al modelo.
   */
  static buildOutgoingMessage(projectId, text, isFirstOfSession) {
    if (!isFirstOfSession) return text;
    return [
      `Trabajas dentro del proyecto "${projectId}" de Jarvis.`,
      'El directorio de trabajo actual ES la carpeta del proyecto.',
      '- El diseño y el contexto de esta idea viven en `conceptual/`; empieza por `_indice.md`.',
      '- Cuando lleguéis a un acuerdo, escríbelo en la nota conceptual que corresponda.',
      '- El código y los artefactos van en `code/`.',
      '- No modifiques nada fuera de este proyecto.',
      '',
      'Mensaje del usuario:',
      text
    ].join('\n');
  }

  /* ------------------------------------------------------------------
   * Persistencia del transcript (durable, para la interfaz)
   * ------------------------------------------------------------------ */
  async _record(projectId, entry) {
    const line = JSON.stringify({
      ...entry,
      at: new Date(entry.at || Date.now()).toISOString()
    });
    try {
      const file = this._transcriptPath(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${line}\n`, 'utf8');
    } catch { /* la interfaz puede repintar desde los eventos; no es crítico */ }
  }

  /* ------------------------------------------------------------------
   * API pública del puerto
   * ------------------------------------------------------------------ */
  async send(projectId, text) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('MESSAGE_REQUIRED');

    const session = await this._ensureSession(projectId);

    await this._record(projectId, { role: 'user', text: clean });
    this._emit(projectId, { type: 'user', text: clean });

    // Se marca ocupado ANTES de enviar: las notificaciones `session.status`
    // pueden llegar y resolverse antes que la respuesta de `session/prompt`,
    // y si marcásemos aquí después dejaríamos el estado pegado en "running".
    session.busy = true;
    this._emit(projectId, { type: 'status', status: 'running' });

    const isFirstOfSession = session.turnCount === 0;
    session.turnCount += 1;
    const outgoing = DshSdkConversationAdapter.buildOutgoingMessage(projectId, clean, isFirstOfSession);

    try {
      const result = await session.rpc.request('session/prompt', {
        sessionId: session.sessionId,
        contentBlocks: [{ type: 'text', text: outgoing }]
      });
      return { messageId: result?.messageId || null, sessionId: session.sessionId };
    } catch (error) {
      session.busy = false;
      this._emit(projectId, { type: 'error', text: error.message });
      this._emit(projectId, { type: 'status', status: 'idle' });
      throw error;
    }
  }

  async history(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    try {
      const raw = await fs.readFile(this._transcriptPath(projectId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  subscribe(projectId, listener) {
    if (!this._sessions.has(projectId)) {
      this._sessions.set(projectId, DshSdkConversationAdapter._placeholder(projectId));
    }
    const session = this._sessions.get(projectId);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  /**
   * Marcador de sesión que aún no tiene proceso: permite suscribirse antes
   * del primer mensaje (la interfaz abre el stream SSE al entrar al proyecto).
   */
  static _placeholder(projectId) {
    return {
      projectId,
      sessionId: null,
      child: null,
      rpc: null,
      status: 'idle',
      busy: false,
      dead: false,
      listeners: new Set(),
      lastActivity: Date.now(),
      idleTimer: null,
      stderrTail: [],
      turnCount: 0
    };
  }

  async status(projectId) {
    const session = this._sessions.get(projectId);
    if (!session || session.dead) {
      return { sessionId: null, status: 'stopped', busy: false };
    }
    return {
      sessionId: session.sessionId,
      status: session.status,
      busy: session.busy
    };
  }

  async reset(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const session = this._sessions.get(projectId);
    if (session && session.child) this._kill(session);
    this._sessions.delete(projectId);
    this._emit(projectId, { type: 'reset' });
    return { reset: true };
  }

  async closeAll() {
    for (const [, session] of this._sessions) {
      if (session.child) this._kill(session);
    }
    this._sessions.clear();
  }
}
