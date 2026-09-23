import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

/**
 * Adaptador de Infraestructura: JarvisWebServer
 * Servidor HTTP ultraligero basado en el módulo nativo `http` de Node.js.
 *
 * Decisiones de diseño (Raspberry Pi 3B):
 *  - CERO dependencias externas: nada de Express/Fastify, ahorro de RAM y de disco.
 *  - La UI (HTML/CSS/JS) se sirve como ficheros estáticos y se ejecuta en el
 *    navegador del usuario (móvil/PC), por lo que la Pi sólo entrega bytes.
 *  - Este adaptador es de infraestructura: sólo traduce HTTP <-> casos de uso.
 *    No contiene lógica de negocio (arquitectura hexagonal).
 */
export class JarvisWebServer {
  constructor({
    getProjectsUseCase,
    getConceptualTreeUseCase,
    runOrchestratorTaskUseCase,
    createProjectUseCase,
    saveNoteUseCase,
    browseProjectFilesUseCase,
    getGitStatusUseCase,
    listOrchestratorTasksUseCase,
    sendChatMessageUseCase,
    getChatHistoryUseCase,
    resetChatUseCase,
    subscribeChatUseCase,
    cancelChatTurnUseCase,
    getChatConfigUseCase,
    setChatConfigUseCase,
    getModelHealthUseCase,
    refreshModelsUseCase,
    getSystemStatusUseCase,
    requestSystemUpdateUseCase,
    checkForUpdatesUseCase,
    publicDir,
    host = '0.0.0.0',
    port = 3081
  }) {
    this.getProjectsUseCase = getProjectsUseCase;
    this.getConceptualTreeUseCase = getConceptualTreeUseCase;
    this.runOrchestratorTaskUseCase = runOrchestratorTaskUseCase;
    this.createProjectUseCase = createProjectUseCase;
    this.saveNoteUseCase = saveNoteUseCase;
    this.browseProjectFilesUseCase = browseProjectFilesUseCase;
    this.getGitStatusUseCase = getGitStatusUseCase;
    this.listOrchestratorTasksUseCase = listOrchestratorTasksUseCase;
    this.sendChatMessageUseCase = sendChatMessageUseCase;
    this.getChatHistoryUseCase = getChatHistoryUseCase;
    this.resetChatUseCase = resetChatUseCase;
    this.subscribeChatUseCase = subscribeChatUseCase;
    this.cancelChatTurnUseCase = cancelChatTurnUseCase;
    this.getChatConfigUseCase = getChatConfigUseCase;
    this.setChatConfigUseCase = setChatConfigUseCase;
    this.getModelHealthUseCase = getModelHealthUseCase;
    this.refreshModelsUseCase = refreshModelsUseCase;
    this.getSystemStatusUseCase = getSystemStatusUseCase;
    this.requestSystemUpdateUseCase = requestSystemUpdateUseCase;
    this.checkForUpdatesUseCase = checkForUpdatesUseCase;
    this.publicDir = publicDir || path.resolve(process.cwd(), 'public');
    this.host = host;
    this.port = port;
    this.server = null;
  }

  /**
   * Envía una respuesta JSON.
   */
  _sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }

  /**
   * Lee y parsea el cuerpo JSON de una petición (con límite de tamaño
   * para no agotar la memoria de la Pi 3B).
   */
  async _readJsonBody(req, maxBytes = 1024 * 256) {
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('PAYLOAD_TOO_LARGE'));
          req.destroy();
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('INVALID_JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Sirve ficheros estáticos del frontend con protección contra path traversal.
   */
  async _serveStatic(res, urlPath) {
    const relative = urlPath === '/' ? '/index.html' : urlPath;
    const resolved = path.resolve(this.publicDir, '.' + relative);

    // Seguridad: impedir salir del directorio public/
    if (!resolved.startsWith(this.publicDir)) {
      return this._sendJson(res, 403, { error: 'FORBIDDEN' });
    }

    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    try {
      const content = await fs.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        // SIN CACHÉ, a propósito. La interfaz entera pesa ~56 KB y se sirve por
        // red local: cachearla no aporta nada y sí provoca el problema más
        // confuso posible — que arregles algo y sigas viendo lo viejo.
        // 'no-cache' no bastaba: algunos navegadores reutilizan la copia igual.
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0'
      });
      res.end(content);
    } catch {
      this._sendJson(res, 404, { error: 'NOT_FOUND', path: urlPath });
    }
  }

  /**
   * Enrutador principal de la API.
   * Rutas:
   *   GET  /api/health
   *   GET  /api/projects
   *   POST /api/projects                       { id, name, description }
   *   GET  /api/projects/:id/conceptual
   *   GET  /api/projects/:id/conceptual/:noteId
   *   PUT  /api/projects/:id/conceptual/:noteId { title, content, frontmatter }
   *   GET  /api/projects/:id/files?zone=code|logs
   *   GET  /api/projects/:id/files/content?zone=code|logs&path=relativa
   *   POST /api/projects/:id/orchestrate        { instruction }
   */
  async _handleApi(req, res, pathname, url) {
    const segments = pathname.split('/').filter(Boolean); // ['api','projects',...]

    // GET /api/health
    if (req.method === 'GET' && pathname === '/api/health') {
      return this._sendJson(res, 200, { status: 'ok', service: 'jarvis-core' });
    }

    // --- Modelos: salud y re-comprobación (sección de administración) ---
    // GET /api/models/health  → qué modelos funcionan, cuáles no tienen cuota
    //                           y cuáles se retiraron por no existir.
    if (req.method === 'GET' && pathname === '/api/models/health') {
      try {
        return this._sendJson(res, 200, await this.getModelHealthUseCase.execute());
      } catch (error) {
        return this._sendJson(res, 500, { error: error.message });
      }
    }

    // POST /api/models/refresh  → sin body: restablece y comprueba TODOS (202,
    //                             en segundo plano). Con { model }: comprueba
    //                             sólo ese modelo y devuelve su salud (200).
    if (req.method === 'POST' && pathname === '/api/models/refresh') {
      try {
        const body = await this._readJsonBody(req);
        const result = await this.refreshModelsUseCase.execute(body?.model);
        return this._sendJson(res, body?.model ? 200 : 202, result);
      } catch (error) {
        return this._sendJson(res, 400, { error: error.message });
      }
    }

    // --- Sistema: actualización de Jarvis ---
    // Ojo: aquí NO se actualiza nada. Se pide y se consulta; quien actualiza
    // es systemd, desde fuera del proceso, para poder revertir si falla.
    if (req.method === 'GET' && pathname === '/api/system/status') {
      try {
        return this._sendJson(res, 200, await this.getSystemStatusUseCase.execute());
      } catch (error) {
        return this._sendJson(res, 500, { error: error.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/system/update') {
      try {
        return this._sendJson(res, 202, await this.requestSystemUpdateUseCase.execute());
      } catch (error) {
        return this._sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/system/check') {
      try {
        return this._sendJson(res, 200, await this.checkForUpdatesUseCase.execute());
      } catch (error) {
        return this._sendJson(res, 500, { error: error.message });
      }
    }

    // GET /api/git/status
    if (req.method === 'GET' && pathname === '/api/git/status') {
      try {
        const git = await this.getGitStatusUseCase.execute();
        return this._sendJson(res, 200, { git });
      } catch (error) {
        return this._sendJson(res, 200, { git: { isRepository: false, error: error.message } });
      }
    }

    // GET /api/projects
    if (req.method === 'GET' && pathname === '/api/projects') {
      const projects = await this.getProjectsUseCase.execute();
      return this._sendJson(res, 200, { projects });
    }

    // POST /api/projects
    if (req.method === 'POST' && pathname === '/api/projects') {
      try {
        const body = await this._readJsonBody(req);
        const project = await this.createProjectUseCase.execute(body);
        return this._sendJson(res, 201, { project });
      } catch (error) {
        return this._sendJson(res, 400, { error: error.message });
      }
    }

    // Rutas con :projectId
    if (segments[0] === 'api' && segments[1] === 'projects' && segments[2]) {
      const projectId = decodeURIComponent(segments[2]);

      // GET /api/projects/:id/conceptual
      if (req.method === 'GET' && segments[3] === 'conceptual' && !segments[4]) {
        const tree = await this.getConceptualTreeUseCase.execute(projectId);
        return this._sendJson(res, 200, { projectId, notes: tree });
      }

      // GET /api/projects/:id/conceptual/:noteId
      if (req.method === 'GET' && segments[3] === 'conceptual' && segments[4]) {
        const noteId = decodeURIComponent(segments[4]);
        const note = await this.saveNoteUseCase.getNote(projectId, noteId);
        if (!note) return this._sendJson(res, 404, { error: 'NOTE_NOT_FOUND' });
        return this._sendJson(res, 200, { note });
      }

      // PUT /api/projects/:id/conceptual/:noteId
      if (req.method === 'PUT' && segments[3] === 'conceptual' && segments[4]) {
        try {
          const noteId = decodeURIComponent(segments[4]);
          const body = await this._readJsonBody(req);
          const saved = await this.saveNoteUseCase.execute({ projectId, noteId, ...body });
          return this._sendJson(res, 200, { note: saved });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // GET /api/projects/:id/files?zone=code|logs
      if (req.method === 'GET' && segments[3] === 'files' && !segments[4]) {
        try {
          const zone = url.searchParams.get('zone') || 'code';
          const files = await this.browseProjectFilesUseCase.list(projectId, zone);
          return this._sendJson(res, 200, { projectId, zone, files });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // GET /api/projects/:id/files/content?zone=code&path=...
      if (req.method === 'GET' && segments[3] === 'files' && segments[4] === 'content') {
        try {
          const zone = url.searchParams.get('zone') || 'code';
          const relPath = url.searchParams.get('path');
          if (!relPath) return this._sendJson(res, 400, { error: 'PATH_REQUIRED' });
          const content = await this.browseProjectFilesUseCase.read(projectId, zone, relPath);
          return this._sendJson(res, 200, { projectId, zone, path: relPath, content });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // GET /api/projects/:id/tasks
      if (req.method === 'GET' && segments[3] === 'tasks') {
        try {
          const tasks = await this.listOrchestratorTasksUseCase.execute(projectId);
          return this._sendJson(res, 200, { projectId, tasks });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // POST /api/projects/:id/orchestrate  (encola y devuelve acuse inmediato)
      if (req.method === 'POST' && segments[3] === 'orchestrate') {
        try {
          const body = await this._readJsonBody(req);
          const result = await this.runOrchestratorTaskUseCase.execute(projectId, body.instruction);
          return this._sendJson(res, 202, { result });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }
      // GET /api/projects/:id/chat  (historial + estado)
      if (req.method === 'GET' && segments[3] === 'chat' && !segments[4]) {
        try {
          const chat = await this.getChatHistoryUseCase.execute(projectId);
          return this._sendJson(res, 200, { projectId, ...chat });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // POST /api/projects/:id/chat  (envía mensaje; responde 202 y el resto llega por SSE)
      if (req.method === 'POST' && segments[3] === 'chat' && !segments[4]) {
        try {
          const body = await this._readJsonBody(req);
          const result = await this.sendChatMessageUseCase.execute(projectId, body.text);
          return this._sendJson(res, 202, { result });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // POST /api/projects/:id/chat/reset  (reinicia la conversación)
      if (req.method === 'POST' && segments[3] === 'chat' && segments[4] === 'reset') {
        try {
          const result = await this.resetChatUseCase.execute(projectId);
          return this._sendJson(res, 200, { projectId, ...result });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // GET /api/projects/:id/chat/config  (catálogo de modelos y opciones)
      if (req.method === 'GET' && segments[3] === 'chat' && segments[4] === 'config') {
        try {
          const config = await this.getChatConfigUseCase.execute(projectId);
          return this._sendJson(res, 200, { projectId, ...config });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // POST /api/projects/:id/chat/config  ({ configId, value })
      if (req.method === 'POST' && segments[3] === 'chat' && segments[4] === 'config') {
        try {
          const body = await this._readJsonBody(req);
          const config = await this.setChatConfigUseCase.execute(body.configId, body.value);
          return this._sendJson(res, 200, { projectId, ...config });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }

      // POST /api/projects/:id/chat/cancel  (detiene el turno en curso)
      if (req.method === 'POST' && segments[3] === 'chat' && segments[4] === 'cancel') {
        try {
          const result = await this.cancelChatTurnUseCase.execute(projectId);
          return this._sendJson(res, 200, { projectId, ...result });
        } catch (error) {
          return this._sendJson(res, 400, { error: error.message });
        }
      }
    }

    return this._sendJson(res, 404, { error: 'ROUTE_NOT_FOUND', pathname });
  }

  /**
   * Server-Sent Events del chat.
   * ------------------------------------------------------------------
   * SSE y no WebSocket a propósito: es una sola dirección (servidor →
   * navegador), viaja sobre HTTP normal y el navegador lo reconecta solo.
   * Implementarlo con el módulo `http` nativo son ~30 líneas, frente a
   * arrastrar una librería de WebSocket en una Pi 3B.
   */
  _handleChatStream(req, res, projectId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Evita que un proxy intermedio acumule la respuesta y la entregue de golpe.
      'X-Accel-Buffering': 'no'
    });
    res.write(': stream abierto\n\n');

    const send = (event) => {
      // Un cliente que se fue no debe provocar un throw en el bucle de eventos.
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let unsubscribe = () => {};
    try {
      unsubscribe = this.subscribeChatUseCase.execute(projectId, send);
    } catch (error) {
      send({ type: 'error', text: error.message });
      res.end();
      return;
    }

    // Comentario periódico: mantiene viva la conexión en móviles y proxies.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  /**
   * Manejador raíz: decide si es API o fichero estático.
   */
  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      // SSE se atiende antes del enrutado JSON: la respuesta queda abierta.
      const streamMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chat\/stream$/);
      if (req.method === 'GET' && streamMatch) {
        return this._handleChatStream(req, res, decodeURIComponent(streamMatch[1]));
      }

      if (pathname.startsWith('/api/')) {
        return await this._handleApi(req, res, pathname, url);
      }
      return await this._serveStatic(res, pathname);
    } catch (error) {
      console.error('[WebServer] Error no controlado:', error);
      if (!res.headersSent) {
        return this._sendJson(res, 500, { error: 'INTERNAL_ERROR', message: error.message });
      }
      res.end();
    }
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server.listen(this.port, this.host, () => {
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      // Cierra también las conexiones SSE abiertas, o el cierre se queda colgado.
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
      this.server.close(() => resolve());
    });
  }
}
