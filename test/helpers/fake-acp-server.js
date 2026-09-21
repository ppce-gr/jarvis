#!/usr/bin/env node
/**
 * Servidor ACP falso para pruebas.
 * ------------------------------------------------------------------
 * Habla el Agent Client Protocol real por stdio: initialize, session/new,
 * session/resume, session/list, session/prompt, session/close, la
 * notificación session/cancel y —lo más delicado— `session/request_permission`,
 * que es una petición DEL SERVIDOR AL CLIENTE y exige respuesta.
 *
 * No gasta tokens ni necesita red.
 *
 * Variables de entorno:
 *   FAKE_ACP_RECORD    ruta donde volcar las peticiones recibidas (JSONL)
 *   FAKE_ACP_SESSIONS  sesiones que devolverá session/list (JSON)
 *   FAKE_ACP_NO_PERM   si vale "1", no pide permisos
 *   FAKE_ACP_CANCEL_SILENT si vale "1", no responde al prompt tras cancelar
 */
import readline from 'node:readline';
import fs from 'node:fs';

const RECORD = process.env.FAKE_ACP_RECORD;
const NO_PERM = process.env.FAKE_ACP_NO_PERM === '1';
const PRESET_SESSIONS = process.env.FAKE_ACP_SESSIONS
  ? JSON.parse(process.env.FAKE_ACP_SESSIONS)
  : [];

let nextServerId = 9000;
const knownSessions = new Set(PRESET_SESSIONS.map((s) => s.sessionId));
let cancelled = false;
const pendingPermission = new Map();

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

/** El servidor PIDE algo al cliente y espera respuesta. */
function serverRequest(method, params) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    pendingPermission.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function record(entry) {
  if (!RECORD) return;
  try { fs.appendFileSync(RECORD, `${JSON.stringify(entry)}\n`); } catch { /* ignorar */ }
}

function emitUpdate(sessionId, update) {
  notify('session/update', { sessionId, update });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }

  // ¿Es la respuesta a una petición nuestra (permisos)?
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingPermission.get(message.id);
    if (resolve) { pendingPermission.delete(message.id); resolve(message); }
    return;
  }

  record({ method: message.method, params: message.params });

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } }
      });
      return;

    case 'session/new': {
      const sessionId = `fake-${Date.now()}`;
      knownSessions.add(sessionId);
      respond(message.id, {
        sessionId,
        configOptions: [
          { id: 'model', category: 'model', currentValue: '["deepseek-official","deepseek-v4-flash"]' },
          { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high' }
        ]
      });
      return;
    }

    case 'session/resume': {
      if (!knownSessions.has(message.params?.sessionId)) {
        respondError(message.id, -32602, `session is not resumable: ${message.params?.sessionId}`);
        return;
      }
      respond(message.id, { configOptions: [] });
      return;
    }

    case 'session/list':
      respond(message.id, { sessions: PRESET_SESSIONS });
      return;

    case 'session/set_config_option':
      respond(message.id, { configs: [] });
      return;

    case 'session/close':
      respond(message.id, {});
      return;

    // `session/cancel` llega como NOTIFICACIÓN (sin id): no se responde.
    case 'session/cancel':
      cancelled = true;
      record({ cancelled: message.params?.sessionId });
      return;

    case 'session/prompt': {
      const sessionId = message.params.sessionId;
      const promptText = (message.params.prompt || [])
        .map((b) => b.text || '').join('');

      if (!NO_PERM) {
        const answer = await serverRequest('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'tc-1', title: 'read_file' },
          options: [
            { optionId: 'reject', name: 'Rechazar', kind: 'reject_once' },
            { optionId: 'allow', name: 'Permitir siempre', kind: 'allow_always' }
          ]
        });
        record({ permissionAnswer: answer.result });
      }

      emitUpdate(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pensando' } });
      emitUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read_file', status: 'in_progress' });
      emitUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });

      // Texto en TROZOS, como hace ACP de verdad.
      const reply = `Recibido: ${promptText.slice(-40)}`;
      for (const trozo of reply.match(/.{1,10}/g) || []) {
        if (cancelled) break;
        emitUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: trozo } });
      }

      cancelled = false;
      respond(message.id, { stopReason: 'end_turn' });
      return;
    }

    default:
      respondError(message.id, -32601, `método desconocido: ${message.method}`);
  }
});

rl.on('close', () => process.exit(0));
