import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationPort } from '../../domain/ports/ConversationPort.js';
import {
  MODEL_STATUS,
  classifyModelFailure,
  annotateModelHealth,
  effortOption,
  flattenModels
} from '../../domain/ModelHealth.js';
import {
  summarizeTool,
  formatToolInput,
  formatToolDetail,
  sanitizeActivity
} from '../../domain/ActivityTrace.js';
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
    brainDir = process.env.JARVIS_BRAIN_DIR || path.resolve(process.cwd(), '..', 'jarvis-vault'),
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
    healthFile = null,
    probeTimeoutMs = Number(process.env.JARVIS_MODEL_PROBE_TIMEOUT_MS || 45 * 1000),
    spawnFn = nodeSpawn
  } = {}) {
    super();
    this.brainDir = brainDir;
    this.dshBin = dshBin;
    this.profile = profile;
    this.dshHome = dshHome;
    this.idleTimeoutMs = idleTimeoutMs;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.spawnFn = spawnFn;

    // Preferencia de modelo y esfuerzo. Se carga de disco si existe; los
    // valores de entorno son sólo el punto de partida.
    this.configFile = configFile || path.join(brainDir, 'chat-config.json');
    this.preferred = {
      model: JSON.stringify([provider, model]),
      reasoning_effort: reasoningEffort
    };
    this._preferredLoaded = false;

    // Registro de salud de modelos. Vive junto a la memoria, no en el repo
    // público. Se carga de disco en la primera consulta.
    this.healthFile = healthFile || path.join(brainDir, 'model-health.json');
    this.probeTimeoutMs = probeTimeoutMs;
    this._health = { checkedAt: null, results: {} };
    this._healthLoaded = false;
    this._checking = false;
    this._checkProgress = null;
    this._probeSessionId = null;
    // Los sondeos van de uno en uno: comparten la sesión de prueba y el
    // proceso de DSH. La cola evita que dos comprobaciones se pisen.
    this._probeQueue = Promise.resolve();

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

    /** Cola de escritura del transcript por proyecto: evita que dos
     *  `appendFile` concurrentes entrelacen líneas. */
    this._recordQueues = new Map();
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
    return path.join(this.brainDir, projectId);
  }

  /**
   * Dónde TRABAJA el agente de este proyecto.
   * ------------------------------------------------------------------
   * Por defecto, su carpeta dentro de la memoria. Pero un proyecto puede
   * declarar otro sitio en `workspace.json`, y eso es lo que permite que un
   * agente trabaje sobre el propio código de Jarvis (proyecto de
   * automodificación) sin sacarlo de su sandbox: el sandbox confina la
   * escritura a este directorio, así que darle el repositorio del código es
   * exactamente lo que le da acceso —y sólo a él—.
   *
   * El `workspace.json` vive junto a las notas, pero apunta a otro sitio.
   * Así la documentación del proyecto sigue en la memoria y las manos del
   * agente van donde haga falta.
   */
  async _workspaceFor(projectId) {
    const porDefecto = this._projectDir(projectId);
    try {
      const raw = await fs.readFile(path.join(porDefecto, 'workspace.json'), 'utf8');
      const { workspace } = JSON.parse(raw);
      if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
        return porDefecto;
      }
      await fs.access(workspace);            // tiene que existir
      return workspace;
    } catch {
      return porDefecto;                      // sin declaración: su carpeta
    }
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
        cwd: this.brainDir,
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
        // La sesión de sondeo muere con el proceso: se pedirá otra.
        this._probeSessionId = null;
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
    // El cwd del agente puede no ser su carpeta de notas: un proyecto
    // puede declarar otro workspace (ver _workspaceFor).
    const projectDir = await this._workspaceFor(projectId);
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
    await this._loadHealth();

    const set = async (configId, value) => {
      if (value === undefined || value === null || value === '') return false;
      try {
        const res = await client.rpc.request('session/set_config_option', {
          sessionId: record.sessionId,
          configId,
          value
        });
        if (res?.configOptions) record.configOptions = res.configOptions;
        return true;
      } catch (error) {
        record.configError = `${configId}: ${error.message}`;
        return false;
      }
    };

    const modelOk = await set('model', this.preferred.model);
    if (!modelOk) {
      // El motor no acepta el modelo guardado: se anota para que desaparezca
      // del selector sin volver a intentarlo.
      const fallo = classifyModelFailure(record.configError);
      if (fallo.status === MODEL_STATUS.BROKEN) {
        await this._noteHealth(this.preferred.model, { status: fallo.status, kind: fallo.kind, error: record.configError });
      }
      return;
    }

    // El esfuerzo SÓLO se envía si el modelo elegido lo admite. DSH publica la
    // opción `reasoning_effort` únicamente para modelos con razonamiento;
    // mandarla a uno que no lo soporta hace fallar el turno.
    const effort = effortOption(record.configOptions);
    if (!effort) {
      record.configError = null;
      await this._noteHealth(this.preferred.model, { supportsEffort: false });
      return;
    }

    const allowed = (effort.options || []).map((o) => String(o.value));
    let wanted = this.preferred.reasoning_effort;
    if (wanted === undefined || wanted === null || wanted === '') {
      wanted = effort.currentValue;
    } else if (allowed.length && !allowed.includes(String(wanted))) {
      // El valor guardado no vale para este modelo: se usa el suyo por defecto.
      wanted = effort.currentValue;
    }
    if (wanted !== undefined && wanted !== null && String(wanted) !== '') {
      const applied = await set('reasoning_effort', String(wanted));
      if (applied && this.preferred.reasoning_effort !== String(wanted)) {
        this.preferred.reasoning_effort = String(wanted);
        await this._savePreferred();
      }
    }
    record.configError = null;
    await this._noteHealth(this.preferred.model, { supportsEffort: true });
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
        // El razonamiento se acumula y se emite una sola vez al cerrar el
        // turno, como bloque plegable: no ensucia el chat a cada token.
        if (text) session.thoughtBuffer = `${session.thoughtBuffer || ''}${text}`;
        break;
      }
      case 'tool_call': {
        const id = update.toolCallId || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const name = update.title || update.name || 'herramienta';
        if (!session.pendingTools) session.pendingTools = new Map();
        const input = formatToolInput(update.rawInput);
        const summary = summarizeTool(name, update.rawInput);
        session.pendingTools.set(id, { name, input, summary });
        this._emit(session.projectId, {
          type: 'tool-call',
          id,
          name,
          summary,
          status: update.status || 'in_progress',
          detail: sanitizeActivity(input)
        });
        break;
      }
      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') break;
        const id = update.toolCallId || null;
        if (!session.pendingTools) session.pendingTools = new Map();
        const pendiente = (id && session.pendingTools.get(id)) || null;
        const name = update.title || update.name || pendiente?.name || 'herramienta';
        const input = pendiente?.input || formatToolInput(update.rawInput);
        const output = AcpConversationAdapter.extractToolText(update.content)
          || AcpConversationAdapter.extractToolText(update.rawOutput);
        const detail = sanitizeActivity(formatToolDetail(input, output));
        const summary = pendiente?.summary || summarizeTool(name, update.rawInput);
        // Se guarda en el transcript al terminar: una línea por herramienta.
        this._record(session.projectId, {
          role: 'tool',
          id,
          text: summary,
          status: update.status,
          detail
        });
        if (id) session.pendingTools.delete(id);
        this._emit(session.projectId, {
          type: 'tool-done',
          id,
          name,
          status: update.status,
          detail
        });
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

  /**
   * Extrae el texto del resultado de una herramienta. ACP lo manda como
   * `[{ type: 'content', content: <ContentBlock> }, …]`, así que se acepta
   * tanto el envoltorio como el bloque suelto.
   */
  static extractToolText(content) {
    if (!Array.isArray(content)) return AcpConversationAdapter.extractText(content);
    const partes = [];
    for (const bloque of content) {
      if (!bloque) continue;
      if (bloque.type === 'content' && bloque.content) {
        const texto = AcpConversationAdapter.extractText(bloque.content);
        if (texto) partes.push(texto);
      } else {
        const texto = AcpConversationAdapter.extractText(bloque);
        if (texto) partes.push(texto);
      }
    }
    return partes.join('\n');
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
    // Se encadena por proyecto para que las líneas salgan en orden aunque
    // varias escrituras (mensaje, herramientas, razonamiento) coincidan.
    const previa = this._recordQueues.get(projectId) || Promise.resolve();
    const siguiente = previa
      .then(async () => {
        const file = this._transcriptPath(projectId);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, `${line}\n`, 'utf8');
      })
      .catch(() => { /* no crítico */ });
    this._recordQueues.set(projectId, siguiente);
    return siguiente;
  }

  /**
   * Cierra la actividad del turno: registra en el transcript las herramientas
   * que quedaran en curso y el razonamiento acumulado, y emite este último
   * como bloque plegable. Se llama ANTES del mensaje final del asistente para
   * que en la conversación quede por encima de la respuesta.
   */
  async _finishTurnActivity(session) {
    if (!session) return;
    if (session.pendingTools && session.pendingTools.size) {
      for (const [id, t] of session.pendingTools) {
        await this._record(session.projectId, {
          role: 'tool',
          id,
          text: t.summary,
          status: 'in_progress',
          detail: sanitizeActivity(t.input)
        });
      }
      session.pendingTools.clear();
    }
    const razonamiento = String(session.thoughtBuffer || '').trim();
    if (razonamiento) {
      const detail = sanitizeActivity(razonamiento);
      await this._record(session.projectId, { role: 'thought', text: 'Razonamiento', detail });
      this._emit(session.projectId, { type: 'reasoning', detail });
    }
    session.thoughtBuffer = '';
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

    // Un turno a la vez por sesión. ACP no etiqueta los deltas con el turno al
    // que pertenecen, así que dos prompts simultáneos mezclarían sus textos en
    // un mismo buffer y el transcript quedaría corrupto. Se rechaza el segundo
    // en vez de arriesgarse: la interfaz deshabilita el campo mientras tanto.
    if (session.busy) {
      throw new Error('CHAT_BUSY: ya hay una respuesta en curso; espera o pulsa Detener');
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
      // Primero la actividad (herramientas y razonamiento) y después la
      // respuesta: así el transcript queda en el orden en que se vivió.
      await this._finishTurnActivity(session);
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
    }).catch(async (error) => {
      session.busy = false;
      session.turnBuffer = '';
      this._clearStallWatchdog(session);
      // Lo que el agente hubiera alcanzado a hacer no se pierde.
      await this._finishTurnActivity(session);
      // Aprender del fallo real: si el modelo no existe o no está disponible
      // se retira de la lista; si fue cuota, se conserva y se avisa.
      this._learnFromFailure(this._currentSelection(session).model, error, projectId).catch(() => {});
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
      if (this._probeSessionId) {
        try { await client.rpc.request('session/close', { sessionId: this._probeSessionId }); } catch { /* ya cerrada */ }
      }
    }
    this._pendingPermissions.clear();
    this._probeSessionId = null;
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
    await this._loadHealth();

    // El catálogo lo publica DSH al crear la sesión. Si todavía no hay ninguna
    // se prepara una: sin catálogo no habría selector de modelo.
    if (!this._catalog) {
      try {
        const session = await this._ensureSession(projectId);
        this._catalog = session.configOptions || [];
      } catch { /* sin catálogo: la interfaz mostrará al menos la selección */ }
    }

    const session = this._sessions.get(projectId);
    const raw = session?.configOptions?.length ? session.configOptions : (this._catalog || []);
    return {
      options: this._decoratedOptions(raw),
      current: this._currentSelection(session, raw),
      health: this._healthSnapshot()
    };
  }

  /** Copia del catálogo con cada modelo anotado con su salud. */
  _decoratedOptions(options) {
    // Se anotan TODOS (también los rotos): el selector los agrupa aparte para
    // que se vean; quien decide si se pueden elegir es la interfaz.
    return annotateModelHealth(options, this._health.results);
  }

  /** Selección vigente, tal como debe verla la interfaz. */
  _currentSelection(session, rawOptions = null) {
    let provider = '';
    let model = '';
    try { [provider, model] = JSON.parse(this.preferred.model); } catch { /* formato inesperado */ }
    const options = rawOptions
      || session?.configOptions
      || this._catalog
      || [];
    return {
      model: this.preferred.model,
      provider,
      modelName: model,
      reasoning_effort: this.preferred.reasoning_effort,
      // Si el catálogo no trae `reasoning_effort`, el modelo no la admite.
      supportsEffort: Boolean(effortOption(options)),
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
    await this._loadHealth();

    const session = [...this._sessions.values()].find((s) => s.sessionId) || null;
    const liveOptions = session?.configOptions?.length ? session.configOptions : (this._catalog || []);

    // El esfuerzo sólo tiene sentido si el modelo elegido lo admite. Se
    // comprueba contra el catálogo real, no contra lo que creamos.
    if (configId === 'reasoning_effort') {
      const effort = effortOption(liveOptions);
      if (liveOptions.length && !effort) {
        throw new Error('REASONING_NOT_SUPPORTED: el modelo actual no admite esfuerzo');
      }
      const allowed = (effort?.options || []).map((o) => String(o.value));
      if (allowed.length && !allowed.includes(String(value))) {
        throw new Error(`CONFIG_VALUE_NOT_SUPPORTED: ${value}`);
      }
    }

    this.preferred[configId] = String(value);
    await this._savePreferred();

    // Aplicar a las sesiones vivas: el cambio rige para el siguiente turno.
    let supportChanged = false;
    let supportsEffort = null;
    if (this._client && !this._client.dead) {
      for (const s of this._sessions.values()) {
        if (!s.sessionId) continue;
        try {
          const res = await this._client.rpc.request('session/set_config_option', {
            sessionId: s.sessionId,
            configId,
            value: String(value)
          });
          if (res?.configOptions) {
            s.configOptions = res.configOptions;
            this._catalog = res.configOptions;
            if (configId === 'model') {
              supportsEffort = Boolean(effortOption(res.configOptions));
              supportChanged = true;
            }
          }
          s.configError = null;
        } catch (error) {
          s.configError = `${configId}: ${error.message}`;
        }
      }
    }

    if (configId === 'model') {
      await this._noteHealth(value, { supportsEffort: supportChanged ? supportsEffort : undefined });
    } else {
      await this._noteHealth(this.preferred.model, { supportsEffort: true });
    }

    const raw = this._catalog || [];
    return {
      options: this._decoratedOptions(raw),
      current: this._currentSelection(session, raw),
      health: this._healthSnapshot()
    };
  }

  /* ------------------------------------------------------------------
   * Salud de modelos
   * ------------------------------------------------------------------ */

  async _loadHealth() {
    if (this._healthLoaded) return this._health;
    this._healthLoaded = true;
    try {
      const raw = await fs.readFile(this.healthFile, 'utf8');
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object' && saved.results && typeof saved.results === 'object') {
        this._health = { checkedAt: saved.checkedAt || null, results: saved.results };
      }
    } catch { /* sin registro previo: todo es desconocido */ }
    return this._health;
  }

  async _saveHealth() {
    try {
      await fs.mkdir(path.dirname(this.healthFile), { recursive: true });
      // Escritura atómica: se escribe a un temporal único y se renombra.
      // Así un lector nunca pilla el fichero a medias (rename es atómico).
      const tmp = `${this.healthFile}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({
        checkedAt: this._health.checkedAt,
        updatedAt: new Date().toISOString(),
        results: this._health.results
      }, null, 2));
      await fs.rename(tmp, this.healthFile);
    } catch { /* no es crítico */ }
  }

  /** Fusiona un resultado en el registro de salud y lo persiste. */
  async _noteHealth(value, patch = {}) {
    if (!value) return;
    const key = String(value);
    const prev = this._health.results[key] || {};
    const next = { ...prev };
    for (const [campo, dato] of Object.entries(patch)) {
      if (dato !== undefined) next[campo] = dato;
    }
    if (next.status === undefined) next.status = MODEL_STATUS.UNKNOWN;
    next.checkedAt = new Date().toISOString();
    this._health.results[key] = next;
    await this._saveHealth();
  }

  /** Etiqueta legible de un valor de modelo (`["p","m"]`). */
  static modelLabel(value) {
    try {
      const [provider, model] = JSON.parse(value);
      return provider && model ? `${provider}/${model}` : String(value);
    } catch {
      return String(value);
    }
  }

  /**
   * Aprende del fallo de un turno real. Sin esto, la lista seguiría
   * ofreciendo modelos que ya sabemos que no funcionan.
   */
  async _learnFromFailure(value, error, projectId = null) {
    if (!value) return null;
    const fallo = classifyModelFailure(error?.message);
    if (fallo.kind === 'effort') {
      await this._noteHealth(value, { supportsEffort: false });
      return fallo;
    }
    if (fallo.status === MODEL_STATUS.QUOTA || fallo.status === MODEL_STATUS.BROKEN) {
      await this._noteHealth(value, {
        status: fallo.status,
        kind: fallo.kind,
        error: String(error?.message || '').slice(0, 400)
      });
      if (projectId) {
        this._emit(projectId, {
          type: 'log',
          text: fallo.status === MODEL_STATUS.BROKEN
            ? `Modelo retirado de la lista (${AcpConversationAdapter.modelLabel(value)}): ${fallo.kind}`
            : `Modelo sin cuota (${AcpConversationAdapter.modelLabel(value)}); se conserva para cuando se restablezca.`
        });
      }
    }
    return fallo;
  }

  _healthSnapshot() {
    return {
      checking: this._checking,
      checkedAt: this._health.checkedAt,
      progress: this._checkProgress,
      results: this._health.results
    };
  }

  /** Salud conocida de los modelos (sin exponer nada interno). */
  async getModelHealth() {
    await this._loadHealth();
    return this._healthSnapshot();
  }

  /**
   * Restablece el registro y vuelve a comprobar TODOS los modelos contra el
   * motor, en segundo plano. Cada comprobación es un turno mínimo, así que
   * se hace de uno en uno para no saturar la Pi ni la cuota.
   */
  async refreshModels() {
    await this._loadHealth();
    await this._loadPreferred();
    if (this._checking) return { started: false, checking: true };

    this._health = { checkedAt: this._health.checkedAt, results: {} };
    this._healthLoaded = true;
    await this._saveHealth();

    this._checking = true;
    this._checkProgress = { done: 0, total: 0, current: null };
    this._runModelCheck()
      .catch(() => { /* cada modelo registra su propio fallo */ })
      .finally(async () => {
        this._checkProgress = null;
        this._health.checkedAt = new Date().toISOString();
        // Si el modelo elegido resultó roto, no dejar al usuario atrapado:
        // se pasa al primero que funcione. La cuota no cuenta (puede volver).
        await this._preferHealthyModel();
        await this._saveHealth();
        // El "checking" se apaga AL FINAL: cuando lo veas en false, el
        // registro ya está persistido y es consistente.
        this._checking = false;
      });
    return { started: true, checking: true };
  }

  /**
   * Vuelve a comprobar SÓLO un modelo. No vacía el registro: actualiza la
   * entrada de ese modelo y deja el resto como estaban. La interfaz lo usa
   * desde el botón de refresco de cada fila del selector.
   */
  async refreshModel(value) {
    const model = String(value ?? '').trim();
    if (!model) throw new Error('MODEL_REQUIRED');
    await this._loadHealth();
    const outcome = await this._serializeProbe(() => this._probeOnce(model));
    await this._noteHealth(model, {
      status: outcome.status,
      kind: outcome.kind,
      error: outcome.error || null,
      supportsEffort: outcome.supportsEffort
    });
    return {
      model,
      status: outcome.status,
      kind: outcome.kind,
      error: outcome.error || null,
      health: this._health.results[model]
    };
  }

  /** Cambia la preferencia a un modelo sano si el actual se retiró. */
  async _preferHealthyModel() {
    const actual = this._health.results[this.preferred.model];
    if (!actual || actual.status !== MODEL_STATUS.BROKEN) return;
    const sano = Object.entries(this._health.results)
      .find(([, r]) => r.status === MODEL_STATUS.OK);
    if (!sano) return;
    this.preferred.model = sano[0];
    await this._savePreferred();
  }

  /** Sesión dedicada al sondeo: no contamina las conversaciones reales. */
  async _ensureProbeSession(client) {
    if (this._probeSessionId) return this._probeSessionId;
    const cwd = path.join(this.brainDir, '.model-check');
    await fs.mkdir(cwd, { recursive: true });
    const created = await client.rpc.request('session/new', { cwd, mcpServers: [] });
    this._probeSessionId = created?.sessionId || null;
    if (created?.configOptions?.length) this._catalog = created.configOptions;
    return this._probeSessionId;
  }

  async _runModelCheck() {
    const client = await this._ensureClient();
    await this._ensureProbeSession(client);
    if (!this._probeSessionId) throw new Error('No se pudo abrir la sesión de comprobación');

    const models = flattenModels(this._catalog || []);
    this._checkProgress = { done: 0, total: models.length, current: null };

    for (const item of models) {
      if (this._client !== client || client.dead) break;
      // El sondeo puede durar minutos: que el proceso no se duerma a mitad.
      this._touchClient();
      this._checkProgress.current = item.value;
      const outcome = await this._serializeProbe(() => this._probeOnce(item.value));
      await this._noteHealth(item.value, {
        status: outcome.status,
        kind: outcome.kind,
        error: outcome.error || null,
        supportsEffort: outcome.supportsEffort
      });
      this._checkProgress.done += 1;
    }

    // La sesión de sondeo no hace falta para nada más.
    await this._serializeProbe(() => this._cerrarProbeSession(client));
  }

  /** Cola de un solo carril: los sondeos comparten sesión y proceso. */
  _serializeProbe(fn) {
    const run = this._probeQueue.then(fn, fn);
    this._probeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Asegura cliente y sesión de prueba, y sondea un modelo. */
  async _probeOnce(value) {
    const client = await this._ensureClient();
    const sessionId = await this._ensureProbeSession(client);
    const outcome = await this._probeModel(client, sessionId, value);
    if (outcome.resetSession) this._probeSessionId = null;
    return outcome;
  }

  async _cerrarProbeSession(client) {
    const probe = this._probeSessionId;
    this._probeSessionId = null;
    if (probe && client && !client.dead) {
      try { await client.rpc.request('session/close', { sessionId: probe }); } catch { /* da igual */ }
    }
  }

  /**
   * Comprueba un modelo con un turno mínimo. Devuelve su estado y si admite
   * esfuerzo. Un timeout cancela el turno y pide sesión nueva.
   */
  async _probeModel(client, sessionId, value) {
    let supportsEffort = null;
    try {
      const res = await client.rpc.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value
      });
      if (res?.configOptions) supportsEffort = Boolean(effortOption(res.configOptions));
    } catch (error) {
      const fallo = classifyModelFailure(error.message);
      if (fallo.kind === 'effort') {
        return { status: MODEL_STATUS.OK, kind: fallo.kind, error: error.message, supportsEffort: false };
      }
      return {
        // Si el catálogo lo listaba y el motor no lo acepta, está roto.
        status: fallo.status === MODEL_STATUS.UNKNOWN ? MODEL_STATUS.BROKEN : fallo.status,
        kind: fallo.kind,
        error: error.message,
        supportsEffort: false
      };
    }

    let timer = null;
    try {
      await Promise.race([
        client.rpc.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: 'Responde únicamente con la palabra OK.' }]
        }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('PROBE_TIMEOUT: el modelo no respondió a tiempo')),
            this.probeTimeoutMs
          );
          if (typeof timer.unref === 'function') timer.unref();
        })
      ]);
      return { status: MODEL_STATUS.OK, kind: 'ok', supportsEffort };
    } catch (error) {
      if (String(error.message).startsWith('PROBE_TIMEOUT')) {
        try { client.rpc.notify('session/cancel', { sessionId }); } catch { /* da igual */ }
        return { status: MODEL_STATUS.UNKNOWN, kind: 'timeout', error: error.message, supportsEffort, resetSession: true };
      }
      const fallo = classifyModelFailure(error.message);
      if (fallo.kind === 'effort') {
        return { status: MODEL_STATUS.OK, kind: fallo.kind, error: error.message, supportsEffort: false };
      }
      return { status: fallo.status, kind: fallo.kind, error: error.message, supportsEffort };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
