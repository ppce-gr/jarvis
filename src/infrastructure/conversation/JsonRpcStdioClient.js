import { EventEmitter } from 'node:events';

/**
 * Adaptador de Infraestructura: JsonRpcStdioClient
 * ------------------------------------------------------------------
 * Cliente JSON-RPC 2.0 sobre stdio con framing por líneas, tal como
 * especifica `@deepseek-ai/dsh-sdk-protocol`:
 *
 *   - un mensaje JSON por línea terminada en `\n`,
 *   - `id` + `method`  → petición,
 *   - `id` solo        → respuesta,
 *   - `method` solo    → notificación,
 *   - las líneas malformadas se ignoran (contrato del protocolo).
 *
 * Se mantiene aparte del adaptador de conversación para poder probar el
 * transporte sin arrancar DSH ni gastar tokens.
 *
 * Implementación deliberadamente pequeña: no usamos una librería de
 * JSON-RPC porque son ~80 líneas y así el proyecto sigue sin dependencias.
 */
export class JsonRpcStdioClient extends EventEmitter {
  /**
   * @param {import('node:child_process').ChildProcess} child
   */
  constructor(child) {
    super();
    this.child = child;
    this._nextId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._closed = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));

    // Si el proceso muere, escribir en su stdin lanza EPIPE. Sin este manejador
    // sería una excepción no capturada capaz de tumbar Jarvis entero: aquí se
    // ignora, porque las peticiones pendientes ya se rechazan en 'close'.
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') this.emit('stdinError', error);
    });

    child.on('error', (error) => this._failAll(error));
    child.on('close', (code, signal) => {
      this._closed = true;
      this._failAll(new Error(`El proceso de conversación terminó (code=${code}, signal=${signal})`));
      this.emit('close', { code, signal });
    });
  }

  /** Acumula y trocea por líneas. Una línea = un frame JSON-RPC. */
  _onData(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (!line) continue;
      this._dispatch(line);
    }
  }

  _dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // El protocolo manda ignorar las líneas malformadas.
      this.emit('malformed', line);
      return;
    }

    const hasId = message.id !== undefined && message.id !== null;
    const hasMethod = typeof message.method === 'string';

    if (hasId && hasMethod) {
      // El servidor no nos pide nada en este perfil; lo ignoramos con elegancia.
      this.emit('request', message);
      return;
    }

    if (hasId) {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'Error JSON-RPC');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (hasMethod) {
      this.emit('notification', message.method, message.params);
    }
  }

  _failAll(error) {
    for (const [, pending] of this._pending) pending.reject(error);
    this._pending.clear();
  }

  /**
   * Envía una petición y espera su respuesta.
   * @returns {Promise<any>} el `result` del frame de respuesta
   */
  request(method, params = {}) {
    if (this._closed) {
      return Promise.reject(new Error('El proceso de conversación ya está cerrado'));
    }
    const id = this._nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.child.stdin.write(`${frame}\n`, 'utf8', (error) => {
        if (error) {
          this._pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** Cierra stdin para que el servidor termine por EOF. */
  closeInput() {
    try {
      this.child.stdin.end();
    } catch { /* ya cerrado */ }
  }

  /**
   * Envía una notificación (sin `id`, sin respuesta).
   * ACP usa esto para `session/cancel`.
   */
  notify(method, params = {}) {
    if (this._closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, 'utf8');
    } catch { /* el proceso ya no está */ }
  }

  /**
   * Responde a una petición que el SERVIDOR nos hizo a nosotros.
   *
   * ACP lo necesita: el servidor pide permisos con `session/request_permission`
   * y espera respuesta antes de continuar. Si no contestamos, el agente se
   * queda bloqueado.
   */
  respond(id, result, error = null) {
    if (this._closed) return;
    const frame = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8');
    } catch { /* el proceso ya no está */ }
  }
}
