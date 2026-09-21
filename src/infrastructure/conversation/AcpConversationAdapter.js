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
  static DEFAULT_PERMISSION_MS = 120 * 1000;
  static DEFAULT_STALL_MS = 10 * 60 * 1000;

  constructor({
    workspaceRoot = process.cwd(),
    dshBin = process.env.JARVIS_DSH_BIN || 'dsh',
    profile = process.env.JARVIS_CHAT_PROFILE || 'acp',
    dshHome = process.env.DSH_HOME || undefined,
    provider = process.env.JARVIS_CHAT_PROVIDER || 'deepseek-official',
    model = process.env.JARVIS_CHAT_MODEL || 'deepseek-v4-flash',
    reasoningEffort = process.env.JARVIS_CHAT_EFFORT || 'high',
    idleTimeoutMs = AcpConversationAdapter.DEFAULT_IDLE_MS,
    permissionTimeoutMs = Number(process.env.JARVIS_PERMISSION_TIMEOUT_MS
      || AcpConversationAdapter.DEFAULT_PERMISSION_MS),
    stallTimeoutMs = Number(process.env.JARVIS_STALL_TIMEOUT_MS
      || AcpConversationAdapter.DEFAULT_STALL_MS),
    configFile = null,
    spawnFn = nodeSpawn
  } = {}) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.dshBin = dshBin;
    this.profile = profile;
    this.dshHome = dshHome;
    this.idleTimeoutMs = idleTimeoutMs;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.spawnFn = spawnFn;

    // Preferencia de modelo y esfuerzo. Se carga de disco si existe; los
    // valores de entorno son sólo el punto de partida.
    this.configFile = configFile || path.join(workspaceRoot, 'chat-config.json');
    this.preferred = {
      model: JSON.stringify([provider, model]),
      reasoning_effort: reasoningEffort
    };
    this._preferredLoaded = false;

    /** @type {null | {child: any, rpc: JsonRpcStdioClient}} */
    this._client = null;
    this._starting = null;

    /** @type {Map<string, object>} projectId -> sesión */
    this._sessions = new Map();

    /** Catálogo de modelos publicado por DSH. Es el mismo para todas las
     *  sesiones, así que se cachea para no arrancar el proceso sólo por él. */
    this._catalog = null;

    /** Peticiones de permiso sin contestar: id JSON-RPC -> datos.
     *  Sirven para dos cosas: no dejar al agente colgado si algo falla, y
     *  poder contestarlas al cerrar para que el servidor termine limpio. */
    this._pendingPermissions = new Map();
  }

  /* ------------------------------------------------------------------
   * Preferencia de modelo (persistida)
   * ------------------------------------------------------------------ */
  async _loadPreferred() {
    if (this._preferredLoaded) return;
    this._preferredLoaded = true;
    try {
      const raw = await fs.readFile(this.configFile, 'utf8');
      const saved = JSON.parse(raw);
      if (saved?.model) this.preferred.model = saved.model;
      if (saved?.reasoning_effort) this.preferred.reasoning_effort = saved.reasoning_effort;
    } catch { /* sin fichero: se usan los valores de entorno */ }
  }

  async _savePreferred() {
    try {
      await fs.mkdir(path.dirname(this.configFile), { recursive: true });
      await fs.writeFile(
        this.configFile,
        JSON.stringify({ ...this.preferred, updatedAt: new Date().toISOString() }, null, 2)
      );
    } catch { /* no es crítico */ }
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
    record.configOptions = created?.configOptions || [];
    await this._storeSession(projectId, record.sessionId);
    await this._applyPreferredConfig(client, record);
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
      if (resumed?.configOptions) record.configOptions = resumed.configOptions;
      await this._storeSession(projectId, sessionId);
      await this._applyPreferredConfig(client, record);
      this._emit(projectId, { type: 'status', status: 'idle' });
      this._emit(projectId, { type: 'log', text: `Conversación reanudada (${sessionId}).` });
      return true;
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

  /**
   * Aplica la preferencia guardada. DSH publica el catálogo de modelos en
   * `session/new`, así que aquí sólo se empuja la elección; la lista de lo
   * disponible se expone aparte en `getConfig()`.
   */
  async _applyPreferredConfig(client, record) {
    if (!record.sessionId) return;
    await this._loadPreferred();
    const set = async (configId, value) => {
      if (value === undefined || value === null || value === '') return;
      try {
        const res = await client.rpc.request('session/set_config_option', {
          sessionId: record.sessionId,
          configId,
          value
        });
        // DSH devuelve el estado completo; se guarda para que la interfaz
        // muestre el valor real, no el que creíamos haber puesto.
        if (res?.configOptions) record.configOptions = res.configOptions;
      } catch (error) {
        record.configError = `${configId}: ${error.message}`;
      }
    };
    await set('model', this.preferred.model);
    await set('reasoning_effort', this.preferred.reasoning_effort);
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
   *
   * Dos redes de seguridad, porque un permiso sin contestar deja al agente
   * colgado para siempre:
   *   1. Se responde de inmediato (perfil de automatización, controller de
   *      confianza), prefiriendo `allow_always`.
   *   2. Si por lo que sea no se hubiera contestado, un temporizador responde
   *      con la opción más conservadora disponible y lo deja anotado. Y si el
   *      cliente se cierra con permisos pendientes, se contestan en `closeAll`
   *      para que el servidor pueda terminar en vez de esperar indefinidamente.
   */
  _onServerRequest(client, message) {
    if (message.method !== 'session/request_permission') {
      client.rpc.respond(message.id, null, { code: -32601, message: `no soportado: ${message.method}` });
      return;
    }

    const options = Array.isArray(message.params?.options) ? message.params.options : [];
    const permitir =
      options.find((o) => o.kind === 'allow_always') ||
      options.find((o) => o.kind === 'allow_once') ||
      options.find((o) => String(o.kind || '').startsWith('allow'));
    const conservadora =
      options.find((o) => o.kind === 'reject_once') ||
      options.find((o) => String(o.kind || '').startsWith('reject')) ||
      options[0];

    const session = this._sessionByAcpId(message.params?.sessionId);
    const elegida = permitir || conservadora;

    const pending = { client, id: message.id, answered: false, fallback: conservadora, session };
    this._pendingPermissions.set(message.id, pending);

    const timer = setTimeout(() => {
      if (pending.answered) return;
      pending.answered = true;
      this._pendingPermissions.delete(message.id);
      // Se responde lo más conservador posible: mejor rechazar que colgar.
      if (conservadora) {
        client.rpc.respond(message.id, { outcome: { outcome: 'selected', optionId: conservadora.optionId } });
      } else {
        client.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } });
      }
      if (session) {
        this._emit(session.projectId, {
          type: 'permission',
          text: `${message.params?.toolCall?.title || 'herramienta'} → sin respuesta a tiempo, rechazado automáticamente`
        });
      }
    }, this.permissionTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    pending.timer = timer;

    if (session) {
      this._emit(session.projectId, {
        type: 'permission',
        text: `${message.params?.toolCall?.title || 'herramienta'} → ${elegida?.name || elegida?.optionId || 'sin opciones'}`
      });
    }

    this._answerPermission(message.id, elegida);
  }

  /** Contesta un permiso pendiente exactamente una vez. */
  _answerPermission(requestId, option) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending || pending.answered) return;
    pending.answered = true;
    clearTimeout(pending.timer);
    this._pendingPermissions.delete(requestId);

    if (!option) {
      pending.client.rpc.respond(requestId, { outcome: { outcome: 'cancelled' } });
      return;
    }
    pending.client.rpc.respond(requestId, {
      outcome: { outcome: 'selected', optionId: option.optionId }
    });
  }

  /**
   * Vigila que un turno en marcha no se quede mudo. No cancela nada: avisa
   * para que el usuario decida, porque una tarea larga legítima (tests,
   * instalación) puede estar minutos sin emitir eventos.
   */
  _armStallWatchdog(session) {
    this._clearStallWatchdog(session);
    if (!(this.stallTimeoutMs > 0)) return;
    session.stallTimer = setTimeout(() => {
      if (!session.busy) return;
      this._emit(session.projectId, {
        type: 'stalled',
        text: `Sin novedades desde hace ${Math.round(this.stallTimeoutMs / 60000)} min. Puede seguir trabajando; si no, pulsa Detener.`
      });
    }, this.stallTimeoutMs);
    if (typeof session.stallTimer.unref === 'function') session.stallTimer.unref();
  }

  _clearStallWatchdog(session) {
    if (session?.stallTimer) {
      clearTimeout(session.stallTimer);
      session.stallTimer = null;
    }
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
    this._armStallWatchdog(session);
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
      this._clearStallWatchdog(session);
      this._emit(projectId, { type: 'turn-end', reason: result?.stopReason || 'end_turn' });
      this._emit(projectId, { type: 'status', status: 'idle' });
      this._touchClient();
    }).catch((error) => {
      session.busy = false;
      session.turnBuffer = '';
      this._clearStallWatchdog(session);
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
      this._clearStallWatchdog(session);
    }
    this._emit(projectId, { type: 'reset' });
    return { reset: true };
  }

  async closeAll() {
    const client = this._client;
    if (client && !client.dead) {
      // Contesta los permisos que quedaran pendientes: si no, el servidor
      // esperaria indefinidamente y no terminaria nunca.
      for (const requestId of [...this._pendingPermissions.keys()]) {
        this._answerPermission(requestId, null);
      }
      for (const session of this._sessions.values()) {
        this._clearStallWatchdog(session);
        if (session.sessionId) {
          try { await client.rpc.request('session/close', { sessionId: session.sessionId }); } catch { /* ya cerrada */ }
        }
      }
    }
    this._pendingPermissions.clear();
    this._shutdownClient();
    this._sessions.clear();
  }

  /* ------------------------------------------------------------------
   * Catalogo de modelos y configuracion
   * ------------------------------------------------------------------ */

  /**
   * Devuelve el catalogo que DSH publica para esta sesion y la seleccion
   * actual. La interfaz lo usa para ofrecer un selector real en vez de
   * obligar a tocar variables de entorno.
   */
  async getConfig(projectId) {
    if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
    await this._loadPreferred();

    // El catálogo lo publica DSH al crear la sesión. Si todavía no hay ninguna
    // se prepara una: sin catálogo no habría selector de modelo.
    if (!this._catalog) {
      try {
        const session = await this._ensureSession(projectId);
        this._catalog = session.configOptions || [];
      } catch { /* sin catálogo: la interfaz mostrará al menos la selección */ }
    }

    const session = this._sessions.get(projectId);
    const options = session?.configOptions?.length ? session.configOptions : (this._catalog || []);
    return { options, current: this._currentSelection(session) };
  }

  /** Selección vigente, tal como debe verla la interfaz. */
  _currentSelection(session) {
    let provider = '';
    let model = '';
    try { [provider, model] = JSON.parse(this.preferred.model); } catch { /* formato inesperado */ }
    return {
      model: this.preferred.model,
      provider,
      modelName: model,
      reasoning_effort: this.preferred.reasoning_effort,
      error: session?.configError || null
    };
  }

  /**
   * Cambia modelo o esfuerzo. Se guarda en disco y se aplica a la sesion viva
   * si la hay; si no, se aplicara al abrirla.
   */
  async setConfig(configId, value) {
    if (!['model', 'reasoning_effort'].includes(configId)) {
      throw new Error(`CONFIG_ID_NOT_SUPPORTED: ${configId}`);
    }
    if (value === undefined || value === null || String(value) === '') {
      throw new Error('CONFIG_VALUE_REQUIRED');
    }
    await this._loadPreferred();
    this.preferred[configId] = String(value);
    await this._savePreferred();

    // Aplicar a las sesiones vivas: el cambio rige para el siguiente turno.
    if (this._client && !this._client.dead) {
      for (const session of this._sessions.values()) {
        if (!session.sessionId) continue;
        try {
          const res = await this._client.rpc.request('session/set_config_option', {
            sessionId: session.sessionId,
            configId,
            value: String(value)
          });
          if (res?.configOptions) {
            session.configOptions = res.configOptions;
            this._catalog = res.configOptions;
          }
          session.configError = null;
        } catch (error) {
          session.configError = `${configId}: ${error.message}`;
        }
      }
    }
    const session = [...this._sessions.values()].find((s) => s.sessionId) || null;
    return { options: this._catalog || [], current: this._currentSelection(session) };
  }
}
