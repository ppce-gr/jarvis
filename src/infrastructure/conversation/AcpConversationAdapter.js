import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationPort } from '../../domain/ports/ConversationPort.js';
import { JsonRpcStdioClient } from './JsonRpcStdioClient.js';

/**
 * Adaptador de Infraestructura: AcpConversationAdapter
 * ==================================================================
 * Chat conversacional sobre el **Agent Client Protocol** estándar
 * (`dsh --profile acp`), impulsado por Zed Industries y JetBrains.
 *
 * POR QUÉ ACP Y NO EL PROTOCOLO SDK DE DSH
 *   El perfil `sdk` expone sólo tres métodos y no tiene ni cancelación ni
 *   reanudación. ACP sí, y además:
 *     - `session/new` recibe el `cwd` POR SESIÓN (el SDK lo fijaba por
 *       proceso, obligando a un proceso por proyecto).
 *     - `session/resume` recupera la memoria del agente desde el disco.
 *     - `session/cancel` aborta de verdad.
 *     - `session/update` manda **deltas** de texto (`agent_message_chunk`),
 *       no sólo el mensaje cerrado.
 *   Y como ACP es un estándar, mañana este adaptador sirve para ~40 agentes.
 *
 * UN SOLO PROCESO PARA TODO
 *   Como el `cwd` va por sesión, un único `dsh --profile acp` atiende a todos
 *   los proyectos, cada uno con su sesión. En una Pi de 905 MB eso es mucho
 *   mejor que un proceso por proyecto. El proceso se apaga solo tras un
 *   periodo de inactividad; las sesiones quedan persistidas y se reanudan.
 *
 * PERMISOS
 *   El servidor pide permiso con `session/request_permission` y **espera
 *   respuesta**; si no contestamos, el agente se bloquea. Este adaptador
 *   responde automáticamente (perfil de automatización, controller de
 *   confianza) prefiriendo `allow_always`, y deja constancia en la bitácora
 *   para que el usuario vea qué se autorizó. Es el mismo nivel de confianza
 *   que ya tenía el modo headless, con el aislamiento de trabajar en la
 *   carpeta del proyecto.
 */
export class AcpConversationAdapter extends ConversationPort {
  static DEFAULT_IDLE_MS = 15 * 60 * 1000;

  constructor({
    workspaceRoot = process.cwd(),
    dshBin = process.env.JARVIS_DSH_BIN || 'dsh',
    profile = process.env.JARVIS_CHAT_PROFILE || 'acp',
    dshHome = process.env.DSH_HOME || undefined,
    provider = process.env.JARVIS_CHAT_PROVIDER || 'deepseek-official',
    model = process.env.JARVIS_CHAT_MODEL || 'deepseek-v4-flash',
    reasoningEffort = process.env.JARVIS_CHAT_EFFORT || 'high',
    idleTimeoutMs = AcpConversationAdapter.DEFAULT_IDLE_MS,
    spawnFn = nodeSpawn
  } = {}) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.dshBin = dshBin;
    this.profile = profile;
    this.dshHome = dshHome;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.idleTimeoutMs = idleTimeoutMs;
    this.spawnFn = spawnFn;

    /** @type {null | {child: any, rpc: JsonRpcStdioClient}} */
    this._client = null;
    this._starting = null;

    /** @type {Map<string, object>} projectId -> sesión */
    this._sessions = new Map();
  }

  /* ------------------------------------------------------------------
   * Rutas
   * ------------------------------------------------------------------ */
  _projectDir(projectId) {
    return path.join(this.workspaceRoot, 'projects', projectId);
  }

  _transcriptPath(projectId) {
    return path.join(this._projectDir(projectId), 'logs', 'conversacion.jsonl');
  }

  _sessionFile(projectId) {
    return path.join(this._projectDir(projectId), 'logs', 'acp-session.json');
  }

  /* ------------------------------------------------------------------
   * Proceso compartido
   * ------------------------------------------------------------------ */
  async _ensureClient() {
    if (this._client && !this._client.dead) {
      this._touchClient();
      return this._client;
    }
    if (this._starting) return this._starting;

    this._starting = (async () => {
      const env = { ...process.env };
      if (this.dshHome) env.DSH_HOME = this.dshHome;

      const child = this.spawnFn(this.dshBin, ['--profile', this.profile], {
        cwd: this.workspaceRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const rpc = new JsonRpcStdioClient(child);
      const client = { child, rpc, dead: false, stderrTail: [], lastActivity: Date.now(), idleTimer: null };
      this._client = client;

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const line = String(chunk).trim();
        if (!line) return;
        client.stderrTail.push(line);
        if (client.stderrTail.length > 20) client.stderrTail.shift();
        for (const projectId of this._sessions.keys()) {
          this._emit(projectId, { type: 'log', text: line });
        }
      });

      rpc.on('notification', (method, params) => this._onNotification(method, params));
      // El servidor nos PIDE cosas (permisos): hay que contestar o se bloquea.
      rpc.on('request', (message) => this._onServerRequest(client, message));

      rpc.on('close', () => {
        client.dead = true;
        this._clearClientIdle(client);
        for (const session of this._sessions.values()) {
          session.sessionId = session.sessionId; // se conserva: es resumible
          session.ready = false;
          this._emit(session.projectId, { type: 'status', status: 'stopped' });
        }
      });

      try {
        await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'jarvis-core', version: '1.0.0' }
        });
      } catch (error) {
        client.dead = true;
        this._client = null;
        const pista = client.stderrTail.slice(-5).join('\n');
        throw new Error(
          `No se pudo inicializar ACP (${this.profile}): ${error.message}` +
          (pista ? `\nÚltimas líneas de DSH:\n${pista}` : '')
        );
      }

      this._touchClient();
      return client;
    })();

    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  _touchClient() {
    const client = this._client;
    if (!client) return;
    client.lastActivity = Date.now();
    this._clearClientIdle(client);
    if (this.idleTimeoutMs > 0) {
      client.idleTimer = setTimeout(() => {
        // No se apaga si hay un turno en marcha: cortaríamos al agente.
        const busy = [...this._sessions.values()].some((s) => s.busy);
        if (busy) {
          this._touchClient();
          return;
        }
        for (const session of this._sessions.values()) {
          this._emit(session.projectId, {
            type: 'log',
            text: 'Conversación dormida por inactividad; se reanudará al escribir.'
          });
          this._emit(session.projectId, { type: 'status', status: 'stopped' });
          session.ready = false;
        }
        this._shutdownClient();
      }, this.idleTimeoutMs);
      if (typeof client.idleTimer.unref === 'function') client.idleTimer.unref();
    }
  }

  _clearClientIdle(client) {
    if (client?.idleTimer) {
      clearTimeout(client.idleTimer);
      client.idleTimer = null;
    }
  }

  /** Cierre limpio: ACP termina por EOF de stdin. */
  _shutdownClient() {
    const client = this._client;
    if (!client) return;
    this._clearClientIdle(client);
    client.rpc.closeInput();
    setTimeout(() => {
      try { client.child.kill('SIGTERM'); } catch { /* ya murió */ }
    }, 2000).unref?.();
    this._client = null;
  }

  /* ------------------------------------------------------------------
   * Sesiones
   * ------------------------------------------------------------------ */
  async _ensureSession(projectId) {
    const session = this._sessions.get(projectId);

    if (session?.sessionId && session.ready) {
      const client = await this._ensureClient();
      if (this._client === client) return session;
    }

    const client = await this._ensureClient();
    const projectDir = this._projectDir(projectId);
    const record = session || {
      projectId,
      sessionId: null,
      ready: false,
      busy: false,
      listeners: session?.listeners || new Set(),
      turnBuffer: '',
      turnCount: 0
    };
    this._sessions.set(projectId, record);

    // 1) Sesión recordada en disco: reanudar recupera la memoria del agente.
    const stored = await this._readStoredSession(projectId);
    if (stored) {
      const resumed = await this._tryResume(client, projectId, stored, projectDir);
      if (resumed) return record;
    }

    // 2) Sesiones persistidas para ese cwd: recoge también las que creó el
    //    adaptador SDK anterior, para no perder conversaciones ya existentes.
    const fromList = await this._findPersistedSession(client, projectDir);
    if (fromList && await this._tryResume(client, projectId, fromList, projectDir)) return record;

    // 3) Sesión nueva.
    const created = await client.rpc.request('session/new', { cwd: projectDir, mcpServers: [] });
    record.sessionId = created?.sessionId || null;
    record.ready = true;
    await this._storeSession(projectId, record.sessionId);
    this._applyPreferredConfig(client, record).catch(() => {});
    this._emit(projectId, { type: 'status', status: 'idle' });
    return record;
  }

  async _tryResume(client, projectId, sessionId, projectDir) {
    try {
      const resumed = await client.rpc.request('session/resume', {
        sessionId,
        cwd: projectDir,
        mcpServers: []
      });
      const record = this._sessions.get(projectId);
      record.sessionId = sessionId;
      record.ready = true;
      await this._storeSession(projectId, sessionId);
      this._applyPreferredConfig(client, record).catch(() => {});
      this._emit(projectId, { type: 'status', status: 'idle' });
      this._emit(projectId, { type: 'log', text: `Conversación reanudada (${sessionId}).` });
      return Boolean(resumed !== undefined || true);
    } catch {
      return false;
    }
  }

  async _findPersistedSession(client, projectDir) {
    try {
      const listed = await client.rpc.request('session/list', { cwd: projectDir });
      const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
      // `session/list` ya viene de la más reciente a la más antigua.
      const match = sessions.find((s) => s.cwd === projectDir) || sessions[0];
      return match?.sessionId || null;
    } catch {
      return null;
    }
  }

  /** Fija modelo y esfuerzo de razonamiento, si la sesión los ofrece. */
  async _applyPreferredConfig(client, record) {
    if (!record.sessionId) return;
    const set = async (configId, value) => {
      try {
        await client.rpc.request('session/set_config_option', {
          sessionId: record.sessionId,
          configId,
          value
        });
      } catch { /* el agente puede no ofrecer esa opción */ }
    };
    await set('model', JSON.stringify([this.provider, this.model]));
    if (this.reasoningEffort) await set('reasoning_effort', this.reasoningEffort);
  }

  async _readStoredSession(projectId) {
    try {
      const raw = await fs.readFile(this._sessionFile(projectId), 'utf8');
      return JSON.parse(raw)?.sessionId || null;
    } catch {
      return null;
    }
  }

  async _storeSession(projectId, sessionId) {
    if (!sessionId) return;
    try {
      const file = this._sessionFile(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ sessionId, at: new Date().toISOString() }, null, 2));
    } catch { /* no es crítico */ }
  }

  /* ------------------------------------------------------------------
   * Eventos y peticiones del servidor
   * ------------------------------------------------------------------ */
  _emit(projectId, event) {
    const session = this._sessions.get(projectId);
    if (!session) return;
    const enriched = { ...event, at: new Date().toISOString() };
    for (const listener of session.listeners) {
      try { listener(enriched); } catch { /* un observador roto no tumba el chat */ }
    }
  }

  _sessionByAcpId(sessionId) {
    for (const session of this._sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return null;
  }

  _onNotification(method, params) {
    if (method !== 'session/update') return;
    const session = this._sessionByAcpId(params?.sessionId);
    if (!session) return;
    this._touchClient();

    const update = params.update || {};
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = AcpConversationAdapter.extractText(update.content);
        if (!text) return;
        session.turnBuffer += text;
        this._emit(session.projectId, { type: 'assistant-chunk', text });
        break;
      }
      case 'agent_thought_chunk': {
        const text = AcpConversationAdapter.extractText(update.content);
        if (text) this._emit(session.projectId, { type: 'thought', text });
        break;
      }
      case 'tool_call': {
        this._emit(session.projectId, {
          type: 'tool-call',
          name: update.title || update.name || 'herramienta',
          status: update.status || 'pending'
        });
        break;
      }
      case 'tool_call_update': {
        if (update.status === 'completed' || update.status === 'failed') {
          this._emit(session.projectId, {
            type: 'tool-done',
            name: update.title || update.name || 'herramienta',
            status: update.status
          });
        }
        break;
      }
      default:
        // plan, usage, session_info… no se pintan en el chat.
        break;
    }
  }

  /**
   * El servidor nos pide permiso para una herramienta y ESPERA respuesta.
   * Se concede automáticamente (perfil de automatización) y se deja rastro.
   */
  _onServerRequest(client, message) {
    if (message.method !== 'session/request_permission') {
      client.rpc.respond(message.id, null, { code: -32601, message: `no soportado: ${message.method}` });
      return;
    }
    const session = this._sessionByAcpId(message.params?.sessionId);
    const options = Array.isArray(message.params?.options) ? message.params.options : [];
    const elegida =
      options.find((o) => o.kind === 'allow_always') ||
      options.find((o) => o.kind === 'allow_once') ||
      options.find((o) => String(o.kind || '').startsWith('allow')) ||
      options.find((o) => String(o.kind || '').startsWith('reject_once')) ||
      options[0];

    if (session) {
      this._emit(session.projectId, {
        type: 'permission',
        text: `${message.params?.toolCall?.title || 'herramienta'} → ${elegida?.name || elegida?.optionId || 'sin opciones'}`
      });
    }

    if (!elegida) {
      client.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    client.rpc.respond(message.id, { outcome: { outcome: 'selected', optionId: elegida.optionId } });
  }

  /** Extrae el texto de un ContentBlock de ACP. */
  static extractText(content) {
    if (!content || typeof content !== 'object') return '';
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    return '';
  }

  /** Contexto del proyecto en el primer mensaje de la sesión. */
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
   * Persistencia del transcript
   * ------------------------------------------------------------------ */
  async _record(projectId, entry) {
    const line = JSON.stringify({ ...entry, at: new Date(entry.at || Date.now()).toISOString() });
    try {
      const file = this._transcriptPath(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${line}\n`, 'utf8');
    } catch { /* no crítico */ }
  }

  /* ------------------------------------------------------------------
   * API pública del puerto
   * ------------------------------------------------------------------ */
  async send(projectId, text) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('MESSAGE_REQUIRED');

    const session = await this._ensureSession(projectId);
    if (!session.ready || !session.sessionId) {
      throw new Error('No se pudo preparar la sesión de conversación con ACP');
    }

    await this._record(projectId, { role: 'user', text: clean });
    this._emit(projectId, { type: 'user', text: clean });

    session.busy = true;
    session.turnBuffer = '';
    this._emit(projectId, { type: 'status', status: 'running' });

    const isFirstOfSession = session.turnCount === 0;
    session.turnCount += 1;
    const outgoing = AcpConversationAdapter.buildOutgoingMessage(projectId, clean, isFirstOfSession);

    // `session/prompt` NO se espera: en ACP esa petición se resuelve cuando el
    // turno termina, y puede tardar minutos. Se lanza y se sigue por eventos;
    // así el HTTP responde al instante.
    this._client.rpc.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: outgoing }]
    }).then(async (result) => {
      const textOut = session.turnBuffer.trim();
      if (textOut) {
        await this._record(projectId, { role: 'assistant', text: textOut });
        this._emit(projectId, { type: 'assistant', text: textOut });
      }
      session.turnBuffer = '';
      session.busy = false;
      this._emit(projectId, { type: 'turn-end', reason: result?.stopReason || 'end_turn' });
      this._emit(projectId, { type: 'status', status: 'idle' });
      this._touchClient();
    }).catch((error) => {
      session.busy = false;
      session.turnBuffer = '';
      this._emit(projectId, { type: 'error', text: error.message });
      this._emit(projectId, { type: 'status', status: 'idle' });
    });

    return { messageId: null, sessionId: session.sessionId };
  }

  async history(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    try {
      const raw = await fs.readFile(this._transcriptPath(projectId), 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  subscribe(projectId, listener) {
    let session = this._sessions.get(projectId);
    if (!session) {
      session = {
        projectId,
        sessionId: null,
        ready: false,
        busy: false,
        listeners: new Set(),
        turnBuffer: '',
        turnCount: 0
      };
      this._sessions.set(projectId, session);
    }
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async status(projectId) {
    const session = this._sessions.get(projectId);
    if (!session || !session.ready) {
      return { sessionId: session?.sessionId || null, status: 'stopped', busy: false };
    }
    return {
      sessionId: session.sessionId,
      status: session.busy ? 'running' : 'idle',
      busy: Boolean(session.busy)
    };
  }

  /**
   * Detiene el turno en curso. A diferencia del adaptador SDK, aquí SÍ se
   * cancela: el agente conserva su memoria.
   */
  async cancel(projectId) {
    const session = this._sessions.get(projectId);
    if (!session?.sessionId || !this._client) return { cancelled: false };
    this._client.rpc.notify('session/cancel', { sessionId: session.sessionId });
    return { cancelled: true };
  }

  /**
   * Reinicia: cierra la sesión y olvida su identificador, de modo que el
   * siguiente mensaje abra una conversación nueva. El transcript en disco se
   * conserva (es la bitácora).
   */
  async reset(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    const session = this._sessions.get(projectId);
    if (session?.sessionId && this._client && !this._client.dead) {
      try {
        await this._client.rpc.request('session/close', { sessionId: session.sessionId });
      } catch { /* puede haberse cerrado ya */ }
    }
    try { await fs.rm(this._sessionFile(projectId)); } catch { /* no existía */ }
    if (session) {
      session.sessionId = null;
      session.ready = false;
      session.busy = false;
      session.turnCount = 0;
      session.turnBuffer = '';
    }
    this._emit(projectId, { type: 'reset' });
    return { reset: true };
  }

  async closeAll() {
    const client = this._client;
    if (client && !client.dead) {
      for (const session of this._sessions.values()) {
        if (session.sessionId) {
          try { await client.rpc.request('session/close', { sessionId: session.sessionId }); } catch { /* ya cerrada */ }
        }
      }
    }
    this._shutdownClient();
    this._sessions.clear();
  }
}
