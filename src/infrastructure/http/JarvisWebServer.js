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
        'Cache-Control': 'no-cache'
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
    }

    return this._sendJson(res, 404, { error: 'ROUTE_NOT_FOUND', pathname });
  }

  /**
   * Manejador raíz: decide si es API o fichero estático.
   */
  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (pathname.startsWith('/api/')) {
        return await this._handleApi(req, res, pathname, url);
      }
      return await this._serveStatic(res, pathname);
    } catch (error) {
      console.error('[WebServer] Error no controlado:', error);
      return this._sendJson(res, 500, { error: 'INTERNAL_ERROR', message: error.message });
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
      this.server.close(() => resolve());
    });
  }
}
